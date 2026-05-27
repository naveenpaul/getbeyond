import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../app.module';
import { createAuth } from '../auth/auth.config';
import { createTestSession } from '../auth/test-session';

/**
 * /contacts/lookup — minimal endpoint the SDR Drafter form uses to resolve
 * a user-entered email into a Contact.id. Tests cover the boundary
 * conditions (missing/invalid email, cross-org isolation) since the
 * happy path is just a Prisma findFirst.
 */

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('GET /contacts/lookup', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;
  let auth: ReturnType<typeof createAuth>;
  let alice: { cookie: string; userId: string; orgId: string };

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (!dbName.includes('test')) {
      throw new Error(
        `Integration tests refuse to run against database "${dbName}".`,
      );
    }
    process.env.CREDENTIAL_MASTER_KEY ??= Buffer.from(
      new Uint8Array(32).fill(7),
    ).toString('base64');
    process.env.AUTH_SECRET ??= 'test-auth-secret-32-chars-padding-to-match';
    process.env.ANTHROPIC_API_KEY ??= 'test-anthropic-key';
    process.env.BRAVE_SEARCH_API_KEY ??= 'test-brave-key';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = new PrismaClient({
      datasources: { db: { url: DATABASE_URL! } },
    });
    await prisma.$connect();
    auth = createAuth(prisma);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        contacts, invites, sessions, accounts, verifications, org_memberships,
        users, organizations
      RESTART IDENTITY CASCADE
    `);
    alice = await createTestSession(prisma, auth, 'alice@test.com');
  });

  it('returns the contact when the email exists in the caller org', async () => {
    await prisma.contact.create({
      data: {
        orgId: alice.orgId,
        normalizedEmail: 'sarah@acme.com',
        firstName: 'Sarah',
        lastName: 'Patel',
        title: 'VP Sales',
        company: 'Acme',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup?email=sarah@acme.com',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      primaryEmail: string;
      firstName: string;
      title: string;
    };
    expect(body.primaryEmail).toBe('sarah@acme.com');
    expect(body.firstName).toBe('Sarah');
    expect(body.title).toBe('VP Sales');
    expect(body.id).toBeTruthy();
  });

  it('normalizes the input email before lookup', async () => {
    // The DB stores normalizedEmail (lowercased, plus-stripped). User
    // input can have mixed case + a +tag and should still resolve.
    await prisma.contact.create({
      data: {
        orgId: alice.orgId,
        normalizedEmail: 'sarah@acme.com',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup?email=Sarah%2Bnewsletters%40Acme.com',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when the email belongs to a different org', async () => {
    const bob = await createTestSession(prisma, auth, 'bob@test.com');
    await prisma.contact.create({
      data: {
        orgId: bob.orgId,
        normalizedEmail: 'lead@bobcorp.com',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup?email=lead@bobcorp.com',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when no contact matches the email', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup?email=nobody@nowhere.com',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when email query param is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when email is malformed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup?email=not-an-email',
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without a session cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/contacts/lookup?email=sarah@acme.com',
    });
    expect(res.statusCode).toBe(401);
  });
});

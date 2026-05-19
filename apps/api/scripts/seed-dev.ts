/**
 * Dev seed: creates (or finds) a single Organization + User and prints
 * the IDs so you can paste them into apps/web/.env.local.
 *
 * Idempotent — re-running picks up the existing rows by name/email.
 *
 *   pnpm --filter @getbeyond/api seed:dev
 */

import { PrismaClient } from '@prisma/client';

const DEV_ORG_NAME = 'getbeyond dev';
const DEV_USER_EMAIL = 'dev@getbeyond.local';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Source your .env (or pass it inline) before running this script.',
    );
  }
  const prisma = new PrismaClient();
  try {
    let org = await prisma.organization.findFirst({
      where: { name: DEV_ORG_NAME },
    });
    if (!org) {
      org = await prisma.organization.create({ data: { name: DEV_ORG_NAME } });
    }

    let user = await prisma.user.findFirst({
      where: { orgId: org.id, email: DEV_USER_EMAIL },
    });
    if (!user) {
      user = await prisma.user.create({
        data: { orgId: org.id, email: DEV_USER_EMAIL, role: 'owner' },
      });
    }

    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log('Dev seed ready. Paste these into apps/web/.env.local:');
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(`NEXT_PUBLIC_DEV_ORG_ID=${org.id}`);
    // eslint-disable-next-line no-console
    console.log(`NEXT_PUBLIC_DEV_USER_ID=${user.id}`);
    // eslint-disable-next-line no-console
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

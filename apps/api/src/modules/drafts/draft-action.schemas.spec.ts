import { describe, expect, it } from 'vitest';
import {
  ArchivePayload,
  CrmLogActivityPayload,
  CrmUpdateFieldPayload,
  CURRENT_PAYLOAD_SCHEMA_VERSION,
  getPayloadSchema,
  PAYLOAD_SCHEMAS,
  PostLinkedinPayload,
  PostTwitterPayload,
  SendEmailPayload,
  UnknownDraftActionKindError,
} from './draft-action.schemas';

describe('DraftAction payload schemas — send_email', () => {
  it('accepts a minimal valid payload', () => {
    const r = SendEmailPayload.safeParse({
      to: 'sarah@acme.com',
      subject: 'Quick question',
      body: 'Hey Sarah — got a minute?',
    });
    expect(r.success).toBe(true);
  });

  it('rejects non-email `to`', () => {
    const r = SendEmailPayload.safeParse({
      to: 'not-an-email',
      subject: 'X',
      body: 'Y',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty subject', () => {
    const r = SendEmailPayload.safeParse({
      to: 'sarah@acme.com',
      subject: '',
      body: 'Y',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty body', () => {
    const r = SendEmailPayload.safeParse({
      to: 'sarah@acme.com',
      subject: 'X',
      body: '',
    });
    expect(r.success).toBe(false);
  });

  it('accepts optional fromName + preheader', () => {
    const r = SendEmailPayload.safeParse({
      to: 'sarah@acme.com',
      fromName: 'Marcus',
      subject: 'X',
      body: 'Y',
      preheader: 'Tiny intro line',
    });
    expect(r.success).toBe(true);
  });
});

describe('DraftAction payload schemas — post_linkedin', () => {
  it('accepts content up to 3000 chars', () => {
    expect(
      PostLinkedinPayload.safeParse({ content: 'a'.repeat(3000) }).success,
    ).toBe(true);
  });

  it('rejects content > 3000 chars', () => {
    expect(
      PostLinkedinPayload.safeParse({ content: 'a'.repeat(3001) }).success,
    ).toBe(false);
  });

  it('accepts optional scheduledFor as a valid ISO datetime', () => {
    expect(
      PostLinkedinPayload.safeParse({
        content: 'hi',
        scheduledFor: '2026-06-01T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('accepts scheduledFor = null (post immediately)', () => {
    expect(
      PostLinkedinPayload.safeParse({ content: 'hi', scheduledFor: null })
        .success,
    ).toBe(true);
  });

  it('rejects non-ISO scheduledFor', () => {
    expect(
      PostLinkedinPayload.safeParse({
        content: 'hi',
        scheduledFor: 'tomorrow',
      }).success,
    ).toBe(false);
  });
});

describe('DraftAction payload schemas — post_twitter', () => {
  it('accepts content up to 280 chars', () => {
    expect(
      PostTwitterPayload.safeParse({ content: 'a'.repeat(280) }).success,
    ).toBe(true);
  });

  it('rejects content > 280 chars', () => {
    expect(
      PostTwitterPayload.safeParse({ content: 'a'.repeat(281) }).success,
    ).toBe(false);
  });
});

describe('DraftAction payload schemas — crm_log_activity', () => {
  it('accepts a typical activity payload', () => {
    expect(
      CrmLogActivityPayload.safeParse({
        contactId: 'cont_abc',
        type: 'email_sent',
        summary: 'Cold email sent',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown activity type', () => {
    expect(
      CrmLogActivityPayload.safeParse({
        contactId: 'cont_abc',
        type: 'lol_invented',
        summary: 's',
      }).success,
    ).toBe(false);
  });

  it('accepts all supported activity types', () => {
    for (const type of ['email_sent', 'note', 'task', 'call', 'meeting'] as const) {
      expect(
        CrmLogActivityPayload.safeParse({
          contactId: 'cont_abc',
          type,
          summary: 's',
        }).success,
      ).toBe(true);
    }
  });
});

describe('DraftAction payload schemas — crm_update_field', () => {
  it('accepts string / number / boolean / null values', () => {
    for (const value of ['VP Eng', 42, true, null]) {
      expect(
        CrmUpdateFieldPayload.safeParse({
          contactId: 'cont_abc',
          field: 'title',
          value,
        }).success,
      ).toBe(true);
    }
  });

  it('rejects object values', () => {
    expect(
      CrmUpdateFieldPayload.safeParse({
        contactId: 'cont_abc',
        field: 'title',
        value: { nope: 1 },
      }).success,
    ).toBe(false);
  });
});

describe('DraftAction payload schemas — archive', () => {
  it('accepts empty object', () => {
    expect(ArchivePayload.safeParse({}).success).toBe(true);
  });
});

describe('getPayloadSchema', () => {
  it('returns the matching schema for every registered kind', () => {
    for (const kind of Object.keys(PAYLOAD_SCHEMAS)) {
      expect(getPayloadSchema(kind)).toBe(
        PAYLOAD_SCHEMAS[kind as keyof typeof PAYLOAD_SCHEMAS],
      );
    }
  });

  it('throws UnknownDraftActionKindError for unregistered kinds', () => {
    try {
      getPayloadSchema('not_a_kind');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownDraftActionKindError);
      expect((err as UnknownDraftActionKindError).kind).toBe('not_a_kind');
    }
  });
});

describe('CURRENT_PAYLOAD_SCHEMA_VERSION', () => {
  it('is a positive integer', () => {
    expect(CURRENT_PAYLOAD_SCHEMA_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(CURRENT_PAYLOAD_SCHEMA_VERSION)).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { NormalizedContact } from '@getbeyond/shared';
import {
  csvSourceAdapter,
  type CsvColumnMapping,
  type CsvSourceConfig,
  type CsvRowError,
} from './csv.source';

async function collect(
  iterable: AsyncIterable<NormalizedContact>,
): Promise<NormalizedContact[]> {
  const out: NormalizedContact[] = [];
  for await (const c of iterable) out.push(c);
  return out;
}

const STANDARD_MAPPING: CsvColumnMapping = {
  email: 'Email',
  firstName: 'First Name',
  lastName: 'Last Name',
  title: 'Title',
  company: 'Company',
  linkedinUrl: 'LinkedIn',
};

function makeConfig(
  content: string,
  mapping: CsvColumnMapping = STANDARD_MAPPING,
): CsvSourceConfig {
  return {
    source: { kind: 'string', content },
    columnMapping: mapping,
  };
}

describe('csvSourceAdapter — contract', () => {
  it('declares kind=csv + authMode=upload', () => {
    expect(csvSourceAdapter.kind).toBe('csv');
    expect(csvSourceAdapter.authMode).toBe('upload');
  });

  it('ping always returns ok (CSV has no remote vendor)', async () => {
    const result = await csvSourceAdapter.ping({});
    expect(result.ok).toBe(true);
    expect(result.scopes).toEqual([]);
  });
});

describe('csvSourceAdapter — happy path', () => {
  it('yields one NormalizedContact per row', async () => {
    const csv = [
      'Email,First Name,Last Name,Title,Company,LinkedIn',
      'sarah@acme.com,Sarah,Chen,VP Eng,Acme,https://linkedin.com/in/sarah',
      'tom@beta.com,Tom,Wells,CTO,Beta,https://linkedin.com/in/tom',
      'priya@gamma.org,Priya,N,Founder,Gamma,',
    ].join('\n');

    const contacts = await collect(
      csvSourceAdapter.syncContacts({ creds: {}, config: makeConfig(csv) }),
    );

    expect(contacts).toHaveLength(3);
    expect(contacts[0]!.emailRaw).toBe('sarah@acme.com');
    expect(contacts[0]!.firstName).toBe('Sarah');
    expect(contacts[0]!.title).toBe('VP Eng');
    expect(contacts[1]!.emailRaw).toBe('tom@beta.com');
    expect(contacts[2]!.emailRaw).toBe('priya@gamma.org');
    expect(contacts[2]!.linkedinUrl).toBeNull(); // empty cell → null
  });

  it('externalId is unique and stable per row (csv:row:N)', async () => {
    const csv = ['Email', 'a@x.com', 'b@x.com', 'c@x.com'].join('\n');
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: makeConfig(csv, { email: 'Email' }),
      }),
    );
    expect(contacts.map((c) => c.externalId)).toEqual([
      'csv:row:1',
      'csv:row:2',
      'csv:row:3',
    ]);
  });

  it('rawPayload preserves every original column on the row', async () => {
    const csv = [
      'Email,Tier,Notes',
      'sarah@acme.com,enterprise,"warm intro from David"',
    ].join('\n');
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: { source: { kind: 'string', content: csv }, columnMapping: { email: 'Email' } },
      }),
    );
    expect(contacts[0]!.rawPayload).toEqual({
      Email: 'sarah@acme.com',
      Tier: 'enterprise',
      Notes: 'warm intro from David',
    });
  });
});

describe('csvSourceAdapter — invalid rows + error reporting', () => {
  it('skips rows with empty email and reports via onRowError', async () => {
    const csv = [
      'Email,First Name',
      'sarah@acme.com,Sarah',
      ',Anonymous',
      'tom@beta.com,Tom',
    ].join('\n');
    const errors: CsvRowError[] = [];
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: csv },
          columnMapping: { email: 'Email', firstName: 'First Name' },
          onRowError: (e) => errors.push(e),
        },
      }),
    );
    expect(contacts).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.row).toBe(2); // 1-indexed
    expect(errors[0]!.reason).toBe('missing_email');
  });

  it('skips whitespace-only email values', async () => {
    const csv = ['Email', 'sarah@acme.com', '   ', '\t'].join('\n');
    const errors: CsvRowError[] = [];
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: csv },
          columnMapping: { email: 'Email' },
          onRowError: (e) => errors.push(e),
        },
      }),
    );
    expect(contacts).toHaveLength(1);
    expect(errors.filter((e) => e.reason === 'missing_email')).toHaveLength(2);
  });

  it('still yields valid rows after a bad row (one bad row does not stop the stream)', async () => {
    // Rows with present-but-empty email cells (NOT entirely-empty lines, which
    // papaparse strips before they hit our loop).
    const csv = [
      'Email,Name',
      'a@x.com,Alice',
      ',Bob',
      'b@x.com,Beth',
      ',Cara',
      'c@x.com,Carl',
    ].join('\n');
    const errors: CsvRowError[] = [];
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: csv },
          columnMapping: { email: 'Email' },
          onRowError: (e) => errors.push(e),
        },
      }),
    );
    expect(contacts).toHaveLength(3);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.reason === 'missing_email')).toBe(true);
  });

  it('emits missing_column error and yields zero contacts when email column is absent', async () => {
    const csv = ['Name,Title', 'Sarah,VP'].join('\n');
    const errors: CsvRowError[] = [];
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: csv },
          columnMapping: { email: 'Email' },
          onRowError: (e) => errors.push(e),
        },
      }),
    );
    expect(contacts).toHaveLength(0);
    expect(errors[0]!.reason).toBe('missing_email');
  });

  it('onRowError is optional — adapter silently skips bad rows when not provided', async () => {
    const csv = ['Email', 'a@x.com', '', 'b@x.com'].join('\n');
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: csv },
          columnMapping: { email: 'Email' },
        },
      }),
    );
    expect(contacts).toHaveLength(2);
  });
});

describe('csvSourceAdapter — field handling', () => {
  it('only email is required; all other mapped columns are optional', async () => {
    const csv = ['Email', 'sarah@acme.com'].join('\n');
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: { source: { kind: 'string', content: csv }, columnMapping: { email: 'Email' } },
      }),
    );
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.firstName).toBeNull();
    expect(contacts[0]!.lastName).toBeNull();
    expect(contacts[0]!.title).toBeNull();
    expect(contacts[0]!.company).toBeNull();
    expect(contacts[0]!.linkedinUrl).toBeNull();
  });

  it('trims surrounding whitespace on field values', async () => {
    const csv = ['Email,First Name', '  sarah@acme.com  ,  Sarah  '].join('\n');
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: csv },
          columnMapping: { email: 'Email', firstName: 'First Name' },
        },
      }),
    );
    expect(contacts[0]!.emailRaw).toBe('sarah@acme.com');
    expect(contacts[0]!.firstName).toBe('Sarah');
  });

  it('converts empty mapped cells to null (not empty string)', async () => {
    const csv = ['Email,Title,Company', 'sarah@acme.com,,Acme'].join('\n');
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: csv },
          columnMapping: { email: 'Email', title: 'Title', company: 'Company' },
        },
      }),
    );
    expect(contacts[0]!.title).toBeNull();
    expect(contacts[0]!.company).toBe('Acme');
  });

  it('handles quoted fields containing commas correctly', async () => {
    const csv = [
      'Email,Company',
      'sarah@acme.com,"Acme, Inc."',
      'tom@beta.com,"Beta Corp, LLC"',
    ].join('\n');
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: csv },
          columnMapping: { email: 'Email', company: 'Company' },
        },
      }),
    );
    expect(contacts[0]!.company).toBe('Acme, Inc.');
    expect(contacts[1]!.company).toBe('Beta Corp, LLC');
  });

  it('preserves unicode in field values', async () => {
    const csv = ['Email,First Name', 'priya@गामा.org,Priya 🚀'].join('\n');
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: csv },
          columnMapping: { email: 'Email', firstName: 'First Name' },
        },
      }),
    );
    expect(contacts[0]!.emailRaw).toBe('priya@गामा.org');
    expect(contacts[0]!.firstName).toBe('Priya 🚀');
  });
});

describe('csvSourceAdapter — empty + malformed inputs', () => {
  it('empty string → yields zero contacts, no errors', async () => {
    const errors: CsvRowError[] = [];
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: '' },
          columnMapping: { email: 'Email' },
          onRowError: (e) => errors.push(e),
        },
      }),
    );
    expect(contacts).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('header-only CSV → yields zero contacts', async () => {
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: 'Email,Name' },
          columnMapping: { email: 'Email' },
        },
      }),
    );
    expect(contacts).toHaveLength(0);
  });

  it('skips truly blank rows (no fire of missing_email)', async () => {
    const csv = ['Email', 'sarah@acme.com', '', '', 'tom@beta.com'].join('\n');
    const errors: CsvRowError[] = [];
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: csv },
          columnMapping: { email: 'Email' },
          onRowError: (e) => errors.push(e),
        },
      }),
    );
    expect(contacts).toHaveLength(2);
    // Empty lines skipped by papaparse's skipEmptyLines — not counted as bad rows.
    expect(errors).toHaveLength(0);
  });
});

describe('csvSourceAdapter — buffer source', () => {
  it('accepts Buffer input', async () => {
    const csv = 'Email\nsarah@acme.com\n';
    const contacts = await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'buffer', content: Buffer.from(csv, 'utf8') },
          columnMapping: { email: 'Email' },
        },
      }),
    );
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.emailRaw).toBe('sarah@acme.com');
  });
});

describe('csvSourceAdapter — onRowError contract', () => {
  it('row error includes 1-indexed row number, reason, and raw row data', async () => {
    const csv = ['Email,Name', 'sarah@acme.com,Sarah', ',Anonymous'].join('\n');
    const onRowError = vi.fn();
    await collect(
      csvSourceAdapter.syncContacts({
        creds: {},
        config: {
          source: { kind: 'string', content: csv },
          columnMapping: { email: 'Email' },
          onRowError,
        },
      }),
    );
    expect(onRowError).toHaveBeenCalledTimes(1);
    expect(onRowError).toHaveBeenCalledWith(
      expect.objectContaining({
        row: 2,
        reason: 'missing_email',
        rawRow: expect.objectContaining({ Email: '', Name: 'Anonymous' }),
      }),
    );
  });
});

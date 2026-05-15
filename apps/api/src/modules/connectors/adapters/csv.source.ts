import Papa from 'papaparse';
import type {
  AuthMode,
  ConnectorKind,
  DecryptedCredentials,
  NormalizedContact,
  PingResult,
  SourceAdapter,
  SyncContactsParams,
} from '@getbeyond/shared';

/**
 * CSV source adapter (eng-review T8-CSV.1).
 *
 * The simplest of the five v1 source adapters: no OAuth, no API key, no rate
 * limits, no remote vendor. Just a stream of bytes from a user upload that
 * the runtime parses into NormalizedContacts.
 *
 * Scope for T8-CSV.1: in-memory parse via Papa.parse on the full string.
 * Sufficient for up to ~50k-row CSVs (typical solo-founder lead list). True
 * streaming parse for 100k+ rows lands in T8-CSV.2 alongside the upload
 * endpoint + worker job.
 *
 * Row-level errors (missing email, malformed cells) are reported via the
 * optional `onRowError` callback — caller (the worker) accumulates them
 * into `SyncRun.errors` for the row-level error report shown post-import.
 */

export type CsvRowErrorReason = 'missing_email' | 'parse_failure';

export interface CsvRowError {
  /** 1-indexed row number (1 = first data row after the header). */
  row: number;
  reason: CsvRowErrorReason;
  message: string;
  /** The raw parsed row data, for the error report UI. */
  rawRow: Record<string, unknown>;
}

export interface CsvColumnMapping {
  /** Required. Column header name that holds the email address. */
  email: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  company?: string;
  linkedinUrl?: string;
}

export interface CsvSourceConfig {
  source:
    | { kind: 'string'; content: string }
    | { kind: 'buffer'; content: Buffer };
  columnMapping: CsvColumnMapping;
  /** Optional callback fired for every row that can't produce a NormalizedContact. */
  onRowError?: (error: CsvRowError) => void;
}

class CsvSourceAdapter implements SourceAdapter<CsvSourceConfig> {
  readonly kind: ConnectorKind = 'csv';
  readonly authMode: AuthMode = 'upload';

  async ping(_creds: DecryptedCredentials): Promise<PingResult> {
    // CSV has no remote vendor to ping. The upload IS the connection.
    return { ok: true, scopes: [] };
  }

  async *syncContacts(
    params: SyncContactsParams<CsvSourceConfig>,
  ): AsyncIterable<NormalizedContact> {
    const { config } = params;
    const csvText =
      config.source.kind === 'string'
        ? config.source.content
        : config.source.content.toString('utf8');

    if (!csvText) return;

    const parsed = Papa.parse<Record<string, unknown>>(csvText, {
      header: true,
      skipEmptyLines: true,
    });

    for (let i = 0; i < parsed.data.length; i++) {
      const row = parsed.data[i] ?? {};
      const rowNum = i + 1;

      const emailRaw = pluckString(row, config.columnMapping.email);
      if (!emailRaw) {
        config.onRowError?.({
          row: rowNum,
          reason: 'missing_email',
          message: `column "${config.columnMapping.email}" empty or missing`,
          rawRow: row,
        });
        continue;
      }

      const contact: NormalizedContact = {
        emailRaw,
        externalId: `csv:row:${rowNum}`,
        firstName: pluckString(row, config.columnMapping.firstName),
        lastName: pluckString(row, config.columnMapping.lastName),
        title: pluckString(row, config.columnMapping.title),
        company: pluckString(row, config.columnMapping.company),
        linkedinUrl: pluckString(row, config.columnMapping.linkedinUrl),
        rawPayload: row,
      };
      yield contact;
    }
  }
}

/**
 * Read + trim a column value from a parsed CSV row. Returns null when the
 * column name is undefined, the value is missing, or the trimmed value is empty.
 */
function pluckString(
  row: Record<string, unknown>,
  column: string | undefined,
): string | null {
  if (!column) return null;
  const value = row[column];
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

export const csvSourceAdapter = new CsvSourceAdapter();

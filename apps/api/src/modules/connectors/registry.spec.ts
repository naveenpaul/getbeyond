import { describe, expect, it } from 'vitest';
import {
  getSourceAdapter,
  isRegisteredSource,
  listRegisteredSources,
  UnknownConnectorError,
} from './registry';
import { csvSourceAdapter } from './adapters/csv.source';

describe('source-adapter registry', () => {
  it('returns the CSV adapter for kind=csv', () => {
    expect(getSourceAdapter('csv')).toBe(csvSourceAdapter);
  });

  it('throws UnknownConnectorError for kinds not yet registered', () => {
    for (const kind of ['hubspot', 'salesforce', 'apollo', 'zoominfo'] as const) {
      try {
        getSourceAdapter(kind);
        expect.fail(`should have thrown for ${kind}`);
      } catch (err) {
        expect(err).toBeInstanceOf(UnknownConnectorError);
        expect((err as UnknownConnectorError).kind).toBe(kind);
      }
    }
  });

  it('UnknownConnectorError message names the missing kind', () => {
    try {
      getSourceAdapter('hubspot');
    } catch (err) {
      expect((err as Error).message).toContain('hubspot');
    }
  });

  it('isRegisteredSource reflects registry state', () => {
    expect(isRegisteredSource('csv')).toBe(true);
    expect(isRegisteredSource('hubspot')).toBe(false);
  });

  it('listRegisteredSources returns only the connectors that are wired', () => {
    expect(listRegisteredSources()).toEqual(['csv']);
  });
});

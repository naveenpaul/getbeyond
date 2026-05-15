import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppController } from './app.controller';

describe('AppController', () => {
  const controller = new AppController();

  it('GET /healthz returns ok status', () => {
    const result = controller.health();
    expect(result.status).toBe('ok');
  });

  describe('version reporting', () => {
    let original: string | undefined;

    beforeEach(() => {
      original = process.env.npm_package_version;
    });

    afterEach(() => {
      if (original === undefined) {
        delete process.env.npm_package_version;
      } else {
        process.env.npm_package_version = original;
      }
    });

    it('returns the npm_package_version env var when set', () => {
      process.env.npm_package_version = '1.2.3';
      expect(controller.health().version).toBe('1.2.3');
    });

    it("falls back to '0.0.0' when npm_package_version is unset", () => {
      delete process.env.npm_package_version;
      expect(controller.health().version).toBe('0.0.0');
    });
  });
});

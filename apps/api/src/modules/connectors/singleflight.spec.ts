import { describe, expect, it, vi } from 'vitest';
import { SingleflightRegistry } from './singleflight';

describe('SingleflightRegistry', () => {
  it('collapses concurrent calls with the same key into one execution', async () => {
    const reg = new SingleflightRegistry<string, number>();
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 42;
    });

    const [a, b, c] = await Promise.all([
      reg.run('k', fn),
      reg.run('k', fn),
      reg.run('k', fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(c).toBe(42);
  });

  it('runs once per distinct key under concurrency', async () => {
    const reg = new SingleflightRegistry<string, string>();
    const fn = vi.fn(async (k: string) => {
      await new Promise((r) => setTimeout(r, 10));
      return k.toUpperCase();
    });

    const [a, b, c, d] = await Promise.all([
      reg.run('alpha', () => fn('alpha')),
      reg.run('beta', () => fn('beta')),
      reg.run('alpha', () => fn('alpha')),
      reg.run('beta', () => fn('beta')),
    ]);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(a).toBe('ALPHA');
    expect(b).toBe('BETA');
    expect(c).toBe('ALPHA');
    expect(d).toBe('BETA');
  });

  it('sequential calls with the same key DO re-execute (entry cleared on settle)', async () => {
    const reg = new SingleflightRegistry<string, number>();
    let count = 0;
    const fn = async () => ++count;

    expect(await reg.run('k', fn)).toBe(1);
    expect(await reg.run('k', fn)).toBe(2);
    expect(await reg.run('k', fn)).toBe(3);
  });

  it('propagates rejections to all concurrent callers + clears the entry', async () => {
    const reg = new SingleflightRegistry<string, number>();
    const err = new Error('boom');
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw err;
    });

    const settled = await Promise.allSettled([
      reg.run('k', fn),
      reg.run('k', fn),
      reg.run('k', fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    for (const r of settled) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') expect(r.reason).toBe(err);
    }

    // After failure, the entry is cleared — next call re-executes.
    const recover = vi.fn(async () => 7);
    expect(await reg.run('k', recover)).toBe(7);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('size() reflects the number of in-flight entries', async () => {
    const reg = new SingleflightRegistry<string, void>();
    let resolveA: (() => void) | undefined;
    let resolveB: (() => void) | undefined;

    const a = reg.run('a', () => new Promise<void>((r) => (resolveA = r)));
    const b = reg.run('b', () => new Promise<void>((r) => (resolveB = r)));

    expect(reg.size()).toBe(2);
    resolveA!();
    await a;
    expect(reg.size()).toBe(1);
    resolveB!();
    await b;
    expect(reg.size()).toBe(0);
  });

  it('one key failing does not affect another key in flight', async () => {
    const reg = new SingleflightRegistry<string, string>();

    const [aResult, bResult] = await Promise.allSettled([
      reg.run('a', async () => {
        throw new Error('a failed');
      }),
      reg.run('b', async () => 'b-ok'),
    ]);

    expect(aResult.status).toBe('rejected');
    expect(bResult.status).toBe('fulfilled');
    if (bResult.status === 'fulfilled') expect(bResult.value).toBe('b-ok');
  });

  it('clear() drops all in-flight entries (test helper)', () => {
    const reg = new SingleflightRegistry<string, void>();
    void reg.run('a', () => new Promise<void>(() => {}));
    void reg.run('b', () => new Promise<void>(() => {}));
    expect(reg.size()).toBe(2);
    reg.clear();
    expect(reg.size()).toBe(0);
  });
});

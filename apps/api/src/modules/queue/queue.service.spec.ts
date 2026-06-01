import { describe, expect, it, vi } from 'vitest';
import type PgBoss from 'pg-boss';
import { QueueService } from './queue.service';

/**
 * Unit coverage for `ensureQueue`'s serialization logic.
 *
 * `queue.service.ts` is otherwise a thin pg-boss wrapper (coverage-excluded,
 * verified via the worker integration suite). `ensureQueue` is the exception:
 * it carries real concurrency logic added to fix a boot deadlock — NestJS
 * fires sibling onModuleInit hooks via Promise.all, so multiple workers raced
 * into `createQueue` (partition DDL on the shared pgboss.queue relation) and
 * Postgres deadlocked (40P01). The fix chains every createQueue onto a single
 * tail promise so the DDL is strictly sequential.
 *
 * These tests pin that behavior without a live DB: a fake boss whose
 * createQueue we control by timing and outcome, driven through the public
 * `send` (which calls ensureQueue then boss.send).
 */

/** Yields a full macrotask so un-serialized callers would overlap if the chain were removed. */
const macrotask = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

interface BossDouble {
  createQueue: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

/** Build a QueueService with a fake boss injected, bypassing onModuleInit. */
function serviceWithBoss(double: BossDouble): QueueService {
  const service = new QueueService();
  (service as unknown as { boss: PgBoss }).boss = double as unknown as PgBoss;
  return service;
}

describe('QueueService.ensureQueue', () => {
  it('serializes concurrent createQueue calls so DDL never runs in parallel', async () => {
    let active = 0;
    let maxActive = 0;
    const createQueue = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await macrotask();
      active -= 1;
    });
    const service = serviceWithBoss({
      createQueue,
      send: vi.fn(async () => 'job'),
    });

    await Promise.all([
      service.send('q1', {}),
      service.send('q2', {}),
      service.send('q3', {}),
    ]);

    expect(createQueue).toHaveBeenCalledTimes(3);
    // Without the chain, all three would enter createQueue before any awaits
    // resolve and maxActive would be 3. Serialized, it stays 1.
    expect(maxActive).toBe(1);
  });

  it('creates each queue exactly once under concurrent same-name calls', async () => {
    const createQueue = vi.fn(async () => {
      await macrotask();
    });
    const service = serviceWithBoss({
      createQueue,
      send: vi.fn(async () => 'job'),
    });

    await Promise.all([
      service.send('dup', {}),
      service.send('dup', {}),
      service.send('dup', {}),
    ]);

    // The in-critical-section re-check skips the 2nd and 3rd once 'dup' is declared.
    expect(createQueue).toHaveBeenCalledTimes(1);
    expect(createQueue).toHaveBeenCalledWith('dup');
  });

  it('short-circuits a queue already declared by an earlier awaited call', async () => {
    const createQueue = vi.fn(async () => undefined);
    const service = serviceWithBoss({
      createQueue,
      send: vi.fn(async () => 'job'),
    });

    await service.send('q1', {});
    await service.send('q1', {});

    expect(createQueue).toHaveBeenCalledTimes(1);
  });

  it('propagates a createQueue failure to its caller without poisoning later callers', async () => {
    const boom = new Error('DDL boom');
    const createQueue = vi.fn(async (name: string) => {
      if (name === 'bad') throw boom;
      await macrotask();
    });
    const service = serviceWithBoss({
      createQueue,
      send: vi.fn(async () => 'job'),
    });

    const badPromise = service.send('bad', {});
    const goodPromise = service.send('good', {});

    // The failing caller sees its own error...
    await expect(badPromise).rejects.toThrow('DDL boom');
    // ...and the next caller in the chain still succeeds.
    await expect(goodPromise).resolves.toBe('job');
    expect(createQueue).toHaveBeenCalledWith('good');
  });

  it('does not cache a failed queue, so a later call retries createQueue', async () => {
    let attempts = 0;
    const createQueue = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
    });
    const service = serviceWithBoss({
      createQueue,
      send: vi.fn(async () => 'job'),
    });

    await expect(service.send('flaky', {})).rejects.toThrow('transient');
    await expect(service.send('flaky', {})).resolves.toBe('job');
    expect(createQueue).toHaveBeenCalledTimes(2);
  });
});

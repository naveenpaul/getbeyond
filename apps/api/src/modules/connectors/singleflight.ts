/**
 * Singleflight registry — collapse concurrent calls keyed on `TKey` into a
 * single in-flight execution (eng-review pass-2 D4 + codex T5).
 *
 * Use case: when a sync worker and an API request both need to refresh the
 * same OAuth account at the same moment, you want exactly one refresh hitting
 * the vendor. The second caller awaits the first's result instead of starting
 * its own request (which would trip rate limits AND race the CAS update).
 *
 * Pure in-memory. Per-process — a multi-instance deployment still needs a
 * distributed lock (Redis / pg_advisory_xact_lock) to be globally singleflight.
 * For v1 the API runs as a single process; the CAS update on
 * `ConnectorAccount.credentialsVersion` is the cross-process safety net.
 */
export class SingleflightRegistry<TKey, TValue> {
  private readonly inflight = new Map<TKey, Promise<TValue>>();

  /**
   * Run `fn` keyed on `key`. If another call with the same key is already
   * in flight, return that call's promise. The function fires at most once
   * per key per in-flight window.
   */
  async run(key: TKey, fn: () => Promise<TValue>): Promise<TValue> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        return await fn();
      } finally {
        // Delete only if our promise is still the one registered.
        // (Defensive — protects against pathological cases where the registry
        // gets cleared mid-flight and a different promise is now registered.)
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key);
        }
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** Number of currently in-flight executions. Exposed for tests. */
  size(): number {
    return this.inflight.size;
  }

  /** Drop all in-flight entries. Use only in tests; production code should never call. */
  clear(): void {
    this.inflight.clear();
  }
}

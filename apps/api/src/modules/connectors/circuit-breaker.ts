/**
 * Per-account circuit breaker (eng-review pass-2 D4 + codex T5).
 *
 * Tracks vendor 5xx failures over a sliding time window. When the failure
 * count crosses the threshold inside the window, the breaker opens. The
 * caller (CredentialManager) then marks `ConnectorAccount.status='circuit_broken'`
 * and persists `circuitOpenedAt` so the state survives process restart.
 *
 * Pure in-memory; per-process. The persistent state on `ConnectorAccount`
 * is what makes this safe across instances — a second API process reading
 * a `circuit_broken` account refuses to load() until cooldown.
 *
 * Half-open probe semantics:
 *   - When cooldown elapses, the CredentialManager flips status back to
 *     `active` and clears the in-memory breaker.
 *   - The next vendor call is the probe. If it fails, the in-memory
 *     breaker re-records and may re-open immediately.
 *   - Anti-flap dampening (T13 P3) extends cooldown on re-open. Not in v1.
 */

export const CIRCUIT_OPEN_THRESHOLD = 10;
export const CIRCUIT_WINDOW_MS = 60_000;
export const CIRCUIT_COOLDOWN_MS = 5 * 60_000;

export class CircuitBreaker {
  /** Failure timestamps inside the current window. */
  private failures: number[] = [];

  /**
   * Record a 5xx failure. Returns `true` if this failure crosses the open
   * threshold (caller should persist circuit_broken state).
   */
  recordFailure(now: number = Date.now()): boolean {
    this.prune(now);
    this.failures.push(now);
    return this.failures.length >= CIRCUIT_OPEN_THRESHOLD;
  }

  /** Current failure count inside the window. */
  failureCount(now: number = Date.now()): number {
    this.prune(now);
    return this.failures.length;
  }

  /** Clear all tracked failures (used on half-open probe success). */
  reset(): void {
    this.failures = [];
  }

  private prune(now: number): void {
    const cutoff = now - CIRCUIT_WINDOW_MS;
    this.failures = this.failures.filter((t) => t >= cutoff);
  }
}

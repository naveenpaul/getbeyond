import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_OPEN_THRESHOLD,
  CIRCUIT_WINDOW_MS,
  CircuitBreaker,
} from './circuit-breaker';

describe('CircuitBreaker', () => {
  it('does not open below the failure threshold', () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD - 1; i++) {
      expect(cb.recordFailure(1000 + i)).toBe(false);
    }
    expect(cb.failureCount(2000)).toBe(CIRCUIT_OPEN_THRESHOLD - 1);
  });

  it('opens exactly at the threshold', () => {
    const cb = new CircuitBreaker();
    let opened = false;
    for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD; i++) {
      opened = cb.recordFailure(1000 + i);
    }
    expect(opened).toBe(true);
  });

  it('drops failures outside the sliding window', () => {
    const cb = new CircuitBreaker();
    // 5 failures inside the window…
    for (let i = 0; i < 5; i++) cb.recordFailure(1000 + i);
    // …then check well past the window. The latest failure is at 1004,
    // so a check at 1004 + CIRCUIT_WINDOW_MS + 1 strips all 5 (cutoff = 1005).
    const muchLater = 1004 + CIRCUIT_WINDOW_MS + 1;
    expect(cb.failureCount(muchLater)).toBe(0);
    // New failure starts a fresh count.
    expect(cb.recordFailure(muchLater)).toBe(false);
    expect(cb.failureCount(muchLater)).toBe(1);
  });

  it('counts only failures inside the window when partially expired', () => {
    const cb = new CircuitBreaker();
    // 6 failures clustered early
    for (let i = 0; i < 6; i++) cb.recordFailure(1000 + i);
    // 4 more inside the window
    const later = 1000 + CIRCUIT_WINDOW_MS - 100;
    for (let i = 0; i < 4; i++) cb.recordFailure(later + i);
    // Advance the clock so only the late 4 survive.
    const checkAt = later + 200;
    expect(cb.failureCount(checkAt)).toBe(4);
  });

  it('reset() clears all tracked failures', () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < 9; i++) cb.recordFailure(1000 + i);
    cb.reset();
    expect(cb.failureCount(2000)).toBe(0);
    // After reset, threshold logic starts from scratch.
    let opened = false;
    for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD; i++) {
      opened = cb.recordFailure(2000 + i);
    }
    expect(opened).toBe(true);
  });
});

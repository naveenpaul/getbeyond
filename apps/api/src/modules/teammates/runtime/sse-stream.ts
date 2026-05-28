import { type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { TERMINAL_RUN_EVENT_TYPES, type RunEvent } from '@getbeyond/shared';
import type { RunEventBus } from './run-event-bus';

const SSE_HEARTBEAT_MS = 15_000;

/**
 * Build the SSE Observable for a teammate run. Same shape used by every
 * teammate's `runs/:id/stream` endpoint — extracted to keep the per-teammate
 * controller bodies focused on validation + tenant scope.
 *
 * Connection lifecycle:
 *   - Replay the bus's buffered events first (mid-run reconnect sees the
 *     history).
 *   - Subscribe to live events; deliver each one once (dedup on
 *     `type|at|JSON.stringify(data)`).
 *   - On a terminal event, close cleanly.
 *   - If the run is ALREADY terminal at connect time AND no terminal event
 *     is in the replay buffer (it aged out of the 60s window), synthesize
 *     one from the DB row so the client doesn't wait forever.
 *   - Heartbeats every 15s keep stale connections detectable.
 */
export function buildRunStreamObservable(args: {
  runId: string;
  runStatus: string;
  eventBus: RunEventBus;
}): Observable<MessageEvent> {
  const { runId, runStatus, eventBus } = args;

  return new Observable<MessageEvent>((subscriber) => {
    const delivered = new Set<string>();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribeBus: (() => void) | undefined;

    const terminate = (): void => {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribeBus?.();
      subscriber.complete();
    };

    const emit = (event: RunEvent): void => {
      const key = `${event.type}|${event.at}|${JSON.stringify(event.data)}`;
      if (delivered.has(key)) return;
      delivered.add(key);
      subscriber.next({ type: event.type, data: event });
      if (TERMINAL_RUN_EVENT_TYPES.has(event.type)) terminate();
    };

    for (const event of eventBus.snapshot(runId)) emit(event);
    unsubscribeBus = eventBus.subscribe(runId, emit);

    const replayHasTerminal = [...delivered].some((key) =>
      Array.from(TERMINAL_RUN_EVENT_TYPES).some((t) => key.startsWith(`${t}|`)),
    );
    if (
      (runStatus === 'completed' ||
        runStatus === 'abstained' ||
        runStatus === 'failed') &&
      !replayHasTerminal
    ) {
      subscriber.next({
        type: `run_${runStatus}`,
        data: {
          type: `run_${runStatus}`,
          runId,
          at: new Date().toISOString(),
          data: { synthesized: true, status: runStatus },
        },
      });
      terminate();
      return () => undefined;
    }

    heartbeat = setInterval(() => {
      subscriber.next({
        type: 'heartbeat',
        data: { at: new Date().toISOString() },
      });
    }, SSE_HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    return () => {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribeBus?.();
    };
  });
}

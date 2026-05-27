'use client';

import { useEffect, useRef, useState } from 'react';
import type { RunEvent, RunEventType } from '@getbeyond/shared';
import { buildResearchStreamUrl } from './api-client';

/**
 * SSE consumer hook (T5.3).
 *
 * Opens an EventSource against the API's /runs/:id/stream endpoint and
 * accumulates events as they arrive. The terminal event (run_completed |
 * run_abstained | run_failed) closes the stream cleanly.
 *
 * Browser EventSource auto-reconnects on transient errors — we don't need
 * to re-implement backoff. On 4xx the connection stays closed (the API
 * already rejected); the hook surfaces that via `connectionState`.
 *
 * Heartbeats arrive every 15s. We ignore them in the events array since
 * they're not part of the audit trail; the hook just uses them implicitly
 * to keep the connection warm.
 */

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

interface UseResearchStreamArgs {
  runId: string | null;
}

interface UseResearchStreamResult {
  events: RunEvent[];
  connectionState: ConnectionState;
  /** True once a terminal event has been delivered. */
  terminated: boolean;
  /** Convenience: the last event by type, if any. */
  last: RunEvent | null;
}

const TERMINAL_TYPES: ReadonlySet<RunEventType> = new Set([
  'run_completed',
  'run_abstained',
  'run_failed',
]);

const HANDLED_TYPES: RunEventType[] = [
  'model_call_started',
  'model_call_completed',
  'tool_call_started',
  'tool_call_completed',
  'draft_emitted',
  'run_completed',
  'run_abstained',
  'run_failed',
];

export function useResearchStream({
  runId,
}: UseResearchStreamArgs): UseResearchStreamResult {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('connecting');
  const [terminated, setTerminated] = useState(false);
  // Track delivered keys so React StrictMode's double-effect doesn't
  // double-render every event (the bus dedups on its side too, but the
  // client receives both copies in dev).
  const deliveredRef = useRef(new Set<string>());

  useEffect(() => {
    if (!runId) return;

    deliveredRef.current = new Set();
    setEvents([]);
    setTerminated(false);
    setConnectionState('connecting');

    const url = buildResearchStreamUrl(runId);
    // withCredentials: true so the session cookie rides along on cross-origin
    // SSE — required for the API's AuthGuard to resolve the user.
    const es = new EventSource(url, { withCredentials: true });

    es.onopen = () => setConnectionState('open');
    es.onerror = () => {
      // EventSource fires onerror on close too. Inspect readyState to tell
      // them apart — CLOSED means the server hung up, anything else is a
      // transient blip that EventSource will retry on its own.
      if (es.readyState === EventSource.CLOSED) {
        setConnectionState('closed');
      } else {
        setConnectionState('error');
      }
    };

    const handle = (event: MessageEvent): void => {
      let parsed: RunEvent;
      try {
        parsed = JSON.parse(event.data) as RunEvent;
      } catch {
        return;
      }
      const key = `${parsed.type}|${parsed.at}|${JSON.stringify(parsed.data)}`;
      if (deliveredRef.current.has(key)) return;
      deliveredRef.current.add(key);

      setEvents((prev) => [...prev, parsed]);
      if (TERMINAL_TYPES.has(parsed.type)) {
        setTerminated(true);
        es.close();
        setConnectionState('closed');
      }
    };

    for (const type of HANDLED_TYPES) {
      es.addEventListener(type, handle as (e: Event) => void);
    }

    return () => {
      es.close();
    };
  }, [runId]);

  return {
    events,
    connectionState,
    terminated,
    last: events.length > 0 ? (events[events.length - 1] ?? null) : null,
  };
}

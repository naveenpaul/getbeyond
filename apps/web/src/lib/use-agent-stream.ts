'use client';

import { useEffect, useRef, useState } from 'react';
import type { RunEvent, RunEventType } from '@getbeyond/shared';

/**
 * Generic SSE consumer hook for any teammate's run stream.
 *
 * Opens an EventSource against `streamUrl` and accumulates RunEvents until
 * a terminal one arrives. Same event shape across all teammates (Researcher,
 * SDR Drafter, future Content Drafter) — the URL is the only thing that
 * changes between callers.
 *
 * Browser EventSource auto-reconnects on transient errors; we don't
 * re-implement backoff. Heartbeats every 15s keep the connection warm and
 * surface a clean "closed" if the server hangs up.
 */

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

interface UseAgentStreamArgs {
  /** Pre-built absolute stream URL. Pass null to skip subscribing. */
  streamUrl: string | null;
}

interface UseAgentStreamResult {
  events: RunEvent[];
  connectionState: ConnectionState;
  terminated: boolean;
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

export function useAgentStream({
  streamUrl,
}: UseAgentStreamArgs): UseAgentStreamResult {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('connecting');
  const [terminated, setTerminated] = useState(false);
  const deliveredRef = useRef(new Set<string>());

  useEffect(() => {
    if (!streamUrl) return;

    deliveredRef.current = new Set();
    setEvents([]);
    setTerminated(false);
    setConnectionState('connecting');

    const es = new EventSource(streamUrl, { withCredentials: true });

    es.onopen = () => setConnectionState('open');
    es.onerror = () => {
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
  }, [streamUrl]);

  return {
    events,
    connectionState,
    terminated,
    last: events.length > 0 ? (events[events.length - 1] ?? null) : null,
  };
}

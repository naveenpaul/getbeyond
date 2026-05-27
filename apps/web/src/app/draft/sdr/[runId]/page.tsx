'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { SdrDrafterRunStatusResponse } from '@getbeyond/shared';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ResearchRunStream } from '@/components/ResearchRunStream';
import { SdrDraftCard } from '@/components/SdrDraftCard';
import {
  ApiError,
  buildSdrDrafterStreamUrl,
  getSdrDrafterRun,
} from '@/lib/api-client';
import { useAgentStream } from '@/lib/use-agent-stream';

/**
 * SDR Drafter run detail. Same shape as the Researcher detail page —
 * live SSE feed via ResearchRunStream, then GET snapshot once terminal,
 * then render the email draft.
 */
export default function SdrDrafterRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}): React.JSX.Element {
  const { runId } = use(params);

  const { events, connectionState, terminated } = useAgentStream({
    streamUrl: buildSdrDrafterStreamUrl(runId),
  });

  const [snapshot, setSnapshot] = useState<SdrDrafterRunStatusResponse | null>(
    null,
  );
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  useEffect(() => {
    if (!terminated) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await getSdrDrafterRun(runId);
        if (!cancelled) setSnapshot(result);
      } catch (err) {
        if (cancelled) return;
        setSnapshotError(
          err instanceof ApiError
            ? `${err.status} — ${err.body.slice(0, 200)}`
            : err instanceof Error
              ? err.message
              : 'Unknown error',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, terminated]);

  return (
    <main className="container space-y-6 py-12">
      <Link
        href="/draft/sdr/new"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        New draft
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-baseline justify-between">
            <span>SDR draft</span>
            <span className="font-mono text-xs text-muted-foreground">
              {runId}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-xs text-muted-foreground">
            stream: <span className="font-mono">{connectionState}</span>
          </div>
          <ResearchRunStream events={events} terminated={terminated} />
        </CardContent>
      </Card>

      {snapshotError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load draft: {snapshotError}
        </div>
      ) : null}

      {snapshot?.draft ? <SdrDraftCard draft={snapshot.draft} /> : null}
    </main>
  );
}

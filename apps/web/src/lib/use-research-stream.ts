'use client';

import { buildResearchStreamUrl } from './api-client';
import { useAgentStream } from './use-agent-stream';
import type { RunEvent } from '@getbeyond/shared';

/**
 * Researcher-specific wrapper around the generic agent stream hook.
 * Kept for call-site clarity; new teammates should call useAgentStream
 * directly with their own streamUrl builder.
 */

interface UseResearchStreamArgs {
  runId: string | null;
}

interface UseResearchStreamResult {
  events: RunEvent[];
  connectionState: 'connecting' | 'open' | 'closed' | 'error';
  terminated: boolean;
  last: RunEvent | null;
}

export function useResearchStream({
  runId,
}: UseResearchStreamArgs): UseResearchStreamResult {
  return useAgentStream({
    streamUrl: runId ? buildResearchStreamUrl(runId) : null,
  });
}

import type { ResearcherDraft } from '@getbeyond/shared';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { CitationChip } from './CitationChip';

interface ResearchDraftCardProps {
  draft: ResearcherDraft;
}

interface ResearchBriefContent {
  headline?: string;
  summary?: string;
  sections?: Array<{ title?: string; body?: string }>;
}

/**
 * Renders a research_brief draft with inline citation chips.
 *
 * The `content` field is loosely-typed JSON because emit_draft accepts
 * arbitrary shapes; the Researcher prompt asks for {headline, summary,
 * sections[]} so we render that shape first and fall through to a JSON
 * dump for unknown shapes. The claim list (with citation links) renders
 * regardless of content shape — that's the trust-positioning piece.
 */
export function ResearchDraftCard({
  draft,
}: ResearchDraftCardProps): React.JSX.Element {
  const content = (draft.content as ResearchBriefContent) ?? {};
  // Per-claim footnote index. We deduplicate by citationId so multiple
  // claims pointing at the same source share one [n].
  const citationIdToIndex = new Map<string, number>();
  let nextIndex = 1;
  for (const claim of draft.claims) {
    if (claim.citationId && !citationIdToIndex.has(claim.citationId)) {
      citationIdToIndex.set(claim.citationId, nextIndex++);
    }
  }
  const sources = [...citationIdToIndex.entries()].map(([citationId, idx]) => {
    const url = draft.claims.find((c) => c.citationId === citationId)
      ?.citationUrl;
    return { citationId, index: idx, url: url ?? null };
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{content.headline ?? 'Research brief'}</CardTitle>
        {content.summary ? (
          <CardDescription>{content.summary}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-5">
        {Array.isArray(content.sections) && content.sections.length > 0 ? (
          content.sections.map((section, i) => (
            <section key={i}>
              {section.title ? (
                <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.title}
                </h3>
              ) : null}
              <p className="text-sm leading-relaxed text-foreground">
                {section.body ?? ''}
              </p>
            </section>
          ))
        ) : null}

        <Separator />

        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Claims
          </h3>
          <ol className="space-y-1.5 text-sm">
            {draft.claims.map((claim) => {
              const index = claim.citationId
                ? citationIdToIndex.get(claim.citationId)
                : undefined;
              return (
                <li key={claim.id} className="text-foreground">
                  {claim.text}
                  {claim.abstained ? (
                    <CitationChip index={0} url={null} abstained />
                  ) : index !== undefined ? (
                    <CitationChip index={index} url={claim.citationUrl} />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>

        {sources.length > 0 ? (
          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Sources
            </h3>
            <ol className="space-y-1 text-sm">
              {sources.map((s) => (
                <li key={s.citationId} className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    [{s.index}]
                  </span>
                  {s.url ? (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {s.url}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">
                      (no URL recorded)
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

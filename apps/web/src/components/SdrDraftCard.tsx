import type { SdrDrafterDraft } from '@getbeyond/shared';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { CitationChip } from './CitationChip';

interface SdrDraftCardProps {
  draft: SdrDrafterDraft;
}

interface EmailContent {
  subject?: string;
  body?: string;
}

/**
 * Renders an email draft (subject + body + cited claims).
 *
 * Mirrors ResearchDraftCard for the email shape. The claim list with
 * footnoted citations stays — that's the user-visible trust mechanic.
 * Each claim is a fact about the prospect's company; the body around them
 * may or may not be cited (greetings, render-only contact attributes,
 * soft CTAs).
 */
export function SdrDraftCard({
  draft,
}: SdrDraftCardProps): React.JSX.Element {
  const content = (draft.content as EmailContent) ?? {};
  const recipient = draft.recipient;

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
        <CardTitle>{content.subject ?? '(no subject)'}</CardTitle>
        {recipient ? (
          <CardDescription>
            To: {recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-5">
        <section>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {content.body ?? ''}
          </p>
        </section>

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

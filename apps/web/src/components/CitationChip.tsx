import { Badge } from '@/components/ui/badge';

interface CitationChipProps {
  /** 1-indexed footnote number for display. */
  index: number;
  url: string | null;
  abstained?: boolean;
}

/**
 * Inline footnote badge for a Claim. Cited claims become a clickable [n]
 * linking to the source; abstained claims become a muted "no source" tag.
 */
export function CitationChip({
  index,
  url,
  abstained,
}: CitationChipProps): React.JSX.Element {
  if (abstained) {
    return (
      <Badge variant="warning" className="ml-1 align-text-top">
        no source
      </Badge>
    );
  }
  if (!url) return <></>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="align-text-top"
      title={url}
    >
      <Badge variant="secondary" className="ml-1 hover:bg-secondary/60">
        [{index}]
      </Badge>
    </a>
  );
}

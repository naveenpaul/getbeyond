import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function LandingPage(): React.JSX.Element {
  return (
    <main className="container flex min-h-screen flex-col items-center justify-center py-16">
      <div className="mx-auto max-w-2xl space-y-8 text-center">
        <div className="space-y-3">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            AI GTM teammates for solo founders.
          </h1>
          <p className="mx-auto max-w-xl text-lg text-muted-foreground">
            Audit every prompt, every claim, every source — in code and in
            the app.
          </p>
        </div>

        <div className="flex items-center justify-center gap-3">
          <Link href="/research/new">
            <Button size="lg">
              Try the Researcher <ArrowRight />
            </Button>
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-6 pt-12 text-left sm:grid-cols-3">
          <Feature
            title="Cite or abstain"
            body="Every claim links to a source the agent actually fetched. The runtime drops claims with no citation — no hallucinations reach the draft."
          />
          <Feature
            title="Open source"
            body="AGPLv3. Read the prompts, audit the tool calls, fork it if you want. The trust positioning is enforced by the code, not the marketing."
          />
          <Feature
            title="Cost-aware by design"
            body="Per-run budget cap, model + tool costs logged on every call, audit log primary in the schema. Solo founders can afford to run this."
          />
        </div>
      </div>
    </main>
  );
}

function Feature({
  title,
  body,
}: {
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

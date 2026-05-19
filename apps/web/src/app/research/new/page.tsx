import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ResearchRunForm } from '@/components/ResearchRunForm';

export default function NewResearchPage(): React.JSX.Element {
  return (
    <main className="container space-y-6 py-12">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Home
      </Link>
      <ResearchRunForm />
    </main>
  );
}

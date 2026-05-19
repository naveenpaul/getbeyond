import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'getbeyond — Open-source AI GTM teammates',
  description:
    'Audit every prompt, every claim, every source. Open source under AGPL-3.0.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  );
}

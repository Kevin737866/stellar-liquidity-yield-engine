import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SkipLink } from '@/components/SkipLink';
import './globals.css';

export const metadata: Metadata = {
  title: 'Stellar Liquidity Yield Engine',
  description: 'Dashboard for monitoring and managing Stellar liquidity positions.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SkipLink />
        {children}
      </body>
    </html>
  );
}

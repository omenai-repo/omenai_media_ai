import type { Metadata } from 'next';
import { Geist, Geist_Mono, Newsreader } from 'next/font/google';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import './globals.css';

const geistSans = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });
const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-newsreader',
  style: ['normal', 'italic'],
  // Optical sizing gives the display cuts at headline sizes.
  axes: ['opsz'],
});

export const metadata: Metadata = {
  title: { default: 'Omenai Newsroom', template: '%s · Omenai Newsroom' },
  description: 'Stories Shaping Culture: the Omenai editorial newsroom.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={cn(geistSans.variable, geistMono.variable, newsreader.variable)}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}

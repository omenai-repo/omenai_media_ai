import type { Metadata } from 'next';
import { Archivo, Geist, Geist_Mono, Newsreader } from 'next/font/google';
import type { ReactNode } from 'react';

import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import './globals.css';

const geistSans = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });
// The masthead face: only the narrow, heavy cut is used, through the width axis (ADR-040).
const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  variable: '--font-archivo',
});
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
    <html
      lang="en"
      className={cn(geistSans.variable, geistMono.variable, archivo.variable, newsreader.variable)}
    >
      <body className="min-h-dvh">
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}

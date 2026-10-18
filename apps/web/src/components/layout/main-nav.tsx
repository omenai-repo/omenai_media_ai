'use client';

import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { Wordmark } from '@/components/brand/wordmark';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

import { SignOutButton } from './sign-out-button';

export interface NavItem {
  href: string;
  label: string;
}

function isActive(pathname: string, href: string) {
  return href === '/'
    ? pathname === '/' || pathname.startsWith('/stories')
    : pathname.startsWith(href);
}

function NavLinks({
  items,
  onNavigate,
  className,
  linkClassName,
}: {
  items: NavItem[];
  onNavigate?: () => void;
  className: string;
  linkClassName: (active: boolean) => string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className={className}>
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn('rounded-sm transition-colors', linkClassName(active))}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Desktop navigation. Owner-only items are passed in only for owners; the server still enforces access. */
export function DesktopNav({ items }: { items: NavItem[] }) {
  return (
    <NavLinks
      items={items}
      className="hidden items-center gap-8 md:flex"
      linkClassName={(active) =>
        cn(
          'py-1 text-sm',
          active
            ? 'text-ink underline decoration-ochre decoration-[1.5px] underline-offset-[0.6rem]'
            : 'text-graphite hover:text-ink',
        )
      }
    />
  );
}

export function MobileNav({ items, name, role }: { items: NavItem[]; name: string; role: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="-ml-2 md:hidden" aria-label="Open menu">
          <Menu aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-80 bg-paper">
        <SheetHeader className="border-b border-hairline pb-5">
          <SheetTitle>
            <Wordmark />
          </SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
        </SheetHeader>
        <NavLinks
          items={items}
          onNavigate={() => setOpen(false)}
          className="flex flex-col px-4"
          linkClassName={(active) =>
            cn(
              'border-b border-hairline py-3 font-display text-2xl',
              active ? 'text-ochre' : 'text-ink',
            )
          }
        />
        <div className="mt-auto flex items-center justify-between gap-3 border-t border-hairline p-4">
          <p className="leading-tight">
            <span className="block text-sm text-ink">{name}</span>
            <span className="meta">{role}</span>
          </p>
          <SignOutButton />
        </div>
      </SheetContent>
    </Sheet>
  );
}

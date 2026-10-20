import { ChevronRight, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import type { Tone } from './copy';

/**
 * The opening of every page: an optional quiet label, then either the masthead face (narrow
 * uppercase Archivo, for the newsroom's own rooms) or a Newsreader headline, and an optional
 * standfirst. `aside` holds the page's own tools, aligned to the title's baseline.
 */
export function PageMasthead({
  eyebrow,
  title,
  size = 'lg',
  children,
  aside,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  size?: 'masthead' | 'xl' | 'lg' | 'md';
  children?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  const titleClass = {
    masthead: 'masthead text-[clamp(3.5rem,2rem+5.2vw,6.5rem)]',
    xl: 'display-xl',
    lg: 'display-lg',
    md: 'display-md',
  }[size];
  return (
    <header
      className={cn('flex flex-wrap items-end justify-between gap-x-12 gap-y-5 pb-2', className)}
    >
      <div className="max-w-[60rem] min-w-0">
        {eyebrow ? <p className="eyebrow mb-3">{eyebrow}</p> : null}
        <h1 className={titleClass}>{title}</h1>
        {children ? <div className="standfirst mt-4 max-w-[60ch]">{children}</div> : null}
      </div>
      {aside ? <div className="flex flex-wrap items-center gap-2.5 pb-1">{aside}</div> : null}
    </header>
  );
}

/** A titled section. Whitespace, not rules, separates sections. */
export function Section({
  title,
  description,
  children,
  className,
  id,
  aside,
  heading = 'label',
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  aside?: ReactNode;
  /** `label`: masthead type, for operational rooms; `serif`: a Newsreader heading. */
  heading?: 'label' | 'serif';
}) {
  const headingId = id ?? `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section aria-labelledby={headingId} className={className}>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <h2
            id={headingId}
            className={
              heading === 'label'
                ? 'masthead text-[1.625rem] leading-[0.95]'
                : 'font-serif text-[1.75rem] leading-tight font-medium sm:text-[1.875rem]'
            }
          >
            {title}
          </h2>
          {description ? <p className="meta mt-1 max-w-[62ch]">{description}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Items separated by a middle dot (trailing, so a wrapped line never starts with one). */
export function MetaLine({ items, className }: { items: ReactNode[]; className?: string }) {
  const shown = items.filter((item) => item !== null && item !== undefined && item !== '');
  if (shown.length === 0) return null;
  return (
    <p className={cn('meta flex flex-wrap items-center gap-x-2 gap-y-1', className)}>
      {shown.map((item, index) => (
        <span key={index} className="inline-flex items-center gap-2">
          {item}
          {index < shown.length - 1 ? (
            <span aria-hidden className="text-stone">
              ·
            </span>
          ) : null}
        </span>
      ))}
    </p>
  );
}

/** Reading text in Newsreader at a comfortable measure. */
export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('prose-editorial space-y-4', className)}>{children}</div>;
}

export function PullQuote({ children, cite }: { children: ReactNode; cite?: string }) {
  return (
    <figure className="border-l-2 border-ink py-1 pl-5">
      <blockquote className="pull-quote text-ink">
        <p>{children}</p>
      </blockquote>
      {cite ? <figcaption className="meta mt-3">{cite}</figcaption> : null}
    </figure>
  );
}

/**
 * Progressive disclosure on a native <details>: keyboard and screen-reader support come free,
 * and the content is still in the page for find-in-page. `row` sits in a list separated by soft
 * hairlines; `card` is a raised group of its own. Opening animates where the browser can.
 */
export function Disclosure({
  summary,
  hint,
  children,
  defaultOpen = false,
  variant = 'row',
  id,
  className,
}: {
  summary: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  variant?: 'row' | 'card';
  id?: string;
  className?: string;
}) {
  return (
    <details
      id={id}
      open={defaultOpen}
      className={cn(
        'disclosure group',
        variant === 'card' ? 'surface scroll-mt-28' : 'border-t border-hairline',
        className,
      )}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-3 rounded-md transition-colors [&::-webkit-details-marker]:hidden',
          variant === 'card' ? 'px-5 py-4 hover:bg-bone/60 sm:px-6' : 'py-4 hover:text-ink',
        )}
      >
        <ChevronRight
          className="size-4 shrink-0 text-ink transition-transform duration-200 group-open:rotate-90"
          aria-hidden
        />
        <span className="font-medium text-ink">{summary}</span>
        {hint ? <span className="meta ml-auto hidden text-right sm:inline">{hint}</span> : null}
      </summary>
      <div
        className={cn(
          'group-open:rise-in',
          variant === 'card' ? 'px-5 pt-1 pb-6 sm:px-6 sm:pl-[3.25rem]' : 'pb-6 pl-7',
        )}
      >
        {children}
      </div>
    </details>
  );
}

/*
 * Colour only where it means something: a wash for a warning or a failure, a hairline for
 * everything else. The icon carries the tone too, so colour is never the only signal.
 */
const TONE_STYLE: Record<Tone, { icon: typeof Info; wash: string; iconClass: string }> = {
  done: { icon: CircleCheck, wash: 'border border-hairline bg-ivory', iconClass: 'text-moss' },
  info: { icon: Info, wash: 'border border-hairline bg-ivory', iconClass: 'text-graphite' },
  attention: { icon: TriangleAlert, wash: 'bg-amber-soft', iconClass: 'text-amber' },
  problem: { icon: CircleAlert, wash: 'bg-oxide-wash', iconClass: 'text-oxide' },
};

/** A short plain-language status, with an icon (never colour alone). */
export function StatusNote({
  tone,
  title,
  children,
  className,
  role,
}: {
  tone: Tone;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
  role?: 'status' | 'alert';
}) {
  const style = TONE_STYLE[tone];
  const Icon = style.icon;
  return (
    <div role={role} className={cn('flex gap-3 rounded-[14px] px-4 py-3.5', style.wash, className)}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', style.iconClass)} aria-hidden />
      <div className="min-w-0 text-[0.9375rem] leading-relaxed">
        <p className="font-medium text-ink">{title}</p>
        {children ? <div className="mt-1 text-graphite">{children}</div> : null}
      </div>
    </div>
  );
}

/** A tone dot with its label, for statuses in lists. */
export function StatusLabel({ tone, children }: { tone: Tone; children: ReactNode }) {
  const style = TONE_STYLE[tone];
  const Icon = style.icon;
  return (
    <span className="inline-flex items-start gap-1.5 text-sm text-ink">
      <Icon className={cn('mt-[3px] size-3.5 shrink-0', style.iconClass)} aria-hidden />
      {children}
    </span>
  );
}

/** A quiet figure: a large serif numeral over a short label. */
export function Figure({
  value,
  label,
  note,
}: {
  value: ReactNode;
  label: string;
  note?: ReactNode;
}) {
  return (
    <div>
      <p className="masthead text-[2.75rem] leading-none tabular-nums">{value}</p>
      <p className="mt-1 text-sm text-ink">{label}</p>
      {note ? <p className="meta mt-0.5">{note}</p> : null}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  className,
}: {
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('surface-quiet px-6 py-10 sm:px-10 sm:py-12', className)}>
      <span aria-hidden className="mb-5 block h-0.5 w-12 bg-ink" />
      <h2 className="display-md max-w-[24ch]">{title}</h2>
      {children ? (
        <div className="mt-4 max-w-[60ch] font-serif text-lg leading-relaxed text-graphite">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A label/value pair for sidebars. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="meta">{label}</dt>
      <dd className="text-[0.9375rem] leading-relaxed text-ink">{children}</dd>
    </div>
  );
}

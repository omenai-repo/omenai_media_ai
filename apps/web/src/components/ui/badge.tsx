import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { Slot } from 'radix-ui';

/*
 * Tags name things (a subject, a flag, a state); they don't colour-code them. The default is a
 * hairline outline; `dark` sits over images, `ink` marks the one flag worth a stronger line, and
 * the semantic variants are coloured text with a dot, never a fill (ADR-040).
 */
const badgeVariants = cva(
  'group/badge inline-flex h-6 w-fit max-w-full min-w-0 shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border px-2.5 text-[0.6875rem] leading-none font-medium tracking-[0.08em] whitespace-nowrap uppercase transition-colors focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-white [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        default: 'border-tag-line text-graphite [a]:hover:border-ink [a]:hover:text-ink',
        outline: 'border-tag-line text-graphite [a]:hover:border-ink [a]:hover:text-ink',
        dark: 'border-white/60 text-white [a]:hover:border-white',
        ink: 'border-ink text-ink',
        secondary: 'border-transparent bg-bone text-graphite',
        ghost: 'border-transparent text-graphite hover:bg-bone',
        link: 'border-transparent text-ink underline-offset-4 hover:underline',
        success:
          'border-transparent px-0 text-moss before:size-1.5 before:rounded-full before:bg-current',
        warning:
          'border-transparent px-0 text-amber before:size-1.5 before:rounded-full before:bg-current',
        danger:
          'border-transparent px-0 text-oxide before:size-1.5 before:rounded-full before:bg-current',
        destructive:
          'border-transparent px-0 text-oxide before:size-1.5 before:rounded-full before:bg-current',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };

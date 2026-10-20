import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { Slot } from 'radix-ui';

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-white active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-ink text-ivory hover:bg-graphite',
        /* The signal: the one primary action on a screen (ADR-040). */
        signal: 'bg-signal text-ink hover:bg-signal-press',
        outline:
          'border-rule-strong bg-ivory text-ink hover:border-ink aria-expanded:border-ink aria-pressed:border-ink',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_srgb,var(--bone),var(--ink)_6%)] aria-expanded:bg-secondary',
        ghost: 'font-medium text-ink hover:bg-bone aria-expanded:bg-bone',
        destructive:
          'bg-oxide-wash text-oxide hover:bg-[color-mix(in_srgb,var(--oxide-wash),var(--oxide)_10%)] focus-visible:ring-destructive/20',
        link: 'text-ink underline-offset-4 hover:underline',
        quiet:
          'h-auto! rounded-sm px-0! py-1.5 font-medium text-graphite underline-offset-4 hover:text-ink hover:underline',
      },
      size: {
        default:
          'h-10 gap-2 px-5 pointer-coarse:h-11 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4',
        xs: "h-7 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3.5 text-[0.8125rem] pointer-coarse:h-11 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-12 gap-2 px-6 text-[0.9375rem] has-data-[icon=inline-end]:pr-5 has-data-[icon=inline-start]:pl-5',
        icon: 'size-10 pointer-coarse:size-11',
        'icon-xs': "size-7 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8 pointer-coarse:size-11',
        'icon-lg': 'size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };

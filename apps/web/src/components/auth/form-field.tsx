import type { ComponentProps } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** A labelled input with an optional hint, wired up for screen readers. */
export function FormField({
  id,
  label,
  hint,
  ...inputProps
}: { id: string; label: string; hint?: string } & ComponentProps<typeof Input>) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="h-11"
        {...inputProps}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

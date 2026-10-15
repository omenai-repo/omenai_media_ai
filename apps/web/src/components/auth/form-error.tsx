import { AlertCircle } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle aria-hidden />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

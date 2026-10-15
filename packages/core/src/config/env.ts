/**
 * Raised when a required integration is not configured. The message always names the missing
 * variable so an operator can fix the deployment instead of guessing.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(
    readonly variable: string,
    detail?: string,
  ) {
    super(
      `Missing or invalid configuration: ${variable}${detail ? ` (${detail})` : ''}. ` +
        'See the README section "Environment variables".',
    );
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(name);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

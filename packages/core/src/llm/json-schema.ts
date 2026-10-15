import * as z from 'zod';

/**
 * Converts a Zod schema to provider-neutral JSON Schema. Adapters then reduce it to the subset
 * their provider supports; full validation always happens afterwards against the Zod schema, so
 * constraints a provider can't enforce are still enforced.
 */
export function toNeutralJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

type JsonObject = Record<string, unknown>;

const CONSTRAINT_LABELS: Record<string, string> = {
  minimum: 'minimum',
  maximum: 'maximum',
  exclusiveMinimum: 'greater than',
  exclusiveMaximum: 'less than',
  minLength: 'min length',
  maxLength: 'max length',
  minItems: 'min items',
  maxItems: 'max items',
  pattern: 'pattern',
};

/**
 * Rewrites a JSON Schema tree for a provider: keeps only `allowed` keywords, and moves dropped
 * constraints into `description` so the model still sees them (e.g. "minimum 0, maximum 5").
 * `transform` can apply provider-specific rewrites to each schema node first.
 */
export function adaptJsonSchema(
  schema: JsonObject,
  allowed: ReadonlySet<string>,
  transform?: (node: JsonObject) => JsonObject,
): JsonObject {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (!input || typeof input !== 'object') return input;

    const node = transform ? transform({ ...(input as JsonObject) }) : { ...(input as JsonObject) };
    const out: JsonObject = {};
    const dropped: string[] = [];

    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' || key === '$defs') {
        out[key] = Object.fromEntries(
          Object.entries(value as JsonObject).map(([name, child]) => [name, visit(child)]),
        );
      } else if (!allowed.has(key)) {
        if (key in CONSTRAINT_LABELS) dropped.push(`${CONSTRAINT_LABELS[key]} ${String(value)}`);
      } else if (key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
        out[key] = visit(value);
      } else if (key === 'additionalProperties' && typeof value === 'object') {
        out[key] = visit(value);
      } else {
        out[key] = value;
      }
    }

    if (dropped.length > 0) {
      const note = `(${dropped.join(', ')})`;
      out.description = typeof out.description === 'string' ? `${out.description} ${note}` : note;
    }
    return out;
  };

  return visit(schema) as JsonObject;
}

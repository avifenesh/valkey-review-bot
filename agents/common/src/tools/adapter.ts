/**
 * Bridge @agent-sh/harness-* tools into @strands-agents/sdk tools.
 *
 * Each harness package exposes its tool as a definition ({ name, description,
 * inputSchema as JSON Schema }) plus a function (input, session) => result.
 * Strands validates tool input with a zod schema, so the JSON Schema is
 * converted to zod and the function is wrapped as the tool callback.
 */
import { z, type ZodTypeAny } from 'zod';
import { tool } from '@strands-agents/sdk';

type HarnessFn<R, S> = (input: unknown, session: S) => Promise<R>;

interface HarnessToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

interface FormatResult {
  // Harness results are a discriminated union: the text for the model is
  // in `output` on success variants and in `error` on error variants.
  readonly kind?: string;
  readonly output?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
}

interface JsonSchemaNode {
  readonly type?: string;
  readonly description?: string;
  readonly items?: JsonSchemaNode;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
}

/**
 * Convert the subset of JSON Schema that the harness tools emit (flat
 * string/number/boolean/array/object schemas with `required`) to zod.
 * Anything else becomes z.any(), which accepts the value as is.
 */
function jsonSchemaToZod(schema: unknown): ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.any();
  const node = schema as JsonSchemaNode;
  const t = node.type;
  if (t === 'string') return z.string();
  if (t === 'integer' || t === 'number') return z.number();
  if (t === 'boolean') return z.boolean();
  if (t === 'array') return z.array(node.items ? jsonSchemaToZod(node.items) : z.any());
  if (t === 'object' || (!t && node.properties)) {
    const shape: Record<string, ZodTypeAny> = {};
    const required = new Set(node.required ?? []);
    for (const [k, v] of Object.entries(node.properties ?? {})) {
      let zv = jsonSchemaToZod(v);
      if (v.description) zv = zv.describe(v.description);
      if (!required.has(k)) zv = zv.optional();
      shape[k] = zv;
    }
    return z.object(shape);
  }
  return z.any();
}

export interface AdaptOptions<R extends FormatResult, S> {
  readonly def: HarnessToolDef;
  readonly fn: HarnessFn<R, S>;
  readonly session: S;
  readonly overrideName?: string;
}

export function adaptHarnessTool<R extends FormatResult, S>(opts: AdaptOptions<R, S>) {
  return tool({
    name: opts.overrideName ?? opts.def.name,
    description: opts.def.description,
    inputSchema: jsonSchemaToZod(opts.def.inputSchema),
    callback: async (input: unknown) => {
      try {
        const result = await opts.fn(input, opts.session);
        if (result.kind === 'error' && result.error) {
          return `ERROR ${result.error.code ?? ''}: ${result.error.message ?? ''}`;
        }
        return result.output ?? JSON.stringify(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `ERROR: ${msg}`;
      }
    },
  });
}

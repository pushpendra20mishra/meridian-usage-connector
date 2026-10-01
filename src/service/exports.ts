import { z } from "zod";

export class ExportError extends Error {}

const DECIMAL = /^-?\d+(\.\d+)?$/;
const count = z.number().int().nonnegative();

const claudeUsageRow = z.object({
  actor: z.object({ user_id: z.string() }),
  starting_at: z.string(),
  product: z.string(),
  model: z.string(),
  rbac_group_id: z.string(),
  requests: count,
  uncached_input_tokens: count,
  cache_read_input_tokens: count,
  cache_creation: z.object({ ephemeral_5m_input_tokens: count, ephemeral_1h_input_tokens: count }),
  output_tokens: count,
  total_tokens: count,
});

const claudeCostRow = z.object({
  actor: z.object({ user_id: z.string() }),
  starting_at: z.string(),
  product: z.string(),
  model: z.string(),
  amount: z.string().regex(DECIMAL, "must be a decimal string"),
  currency: z.string().optional(),
});

const geminiRow = z.object({
  service: z.object({ description: z.string() }),
  sku: z.object({ description: z.string() }),
  usage_start_time: z.string(),
  project: z.object({ id: z.string() }),
  labels: z.array(z.object({ key: z.string(), value: z.string() })),
  cost: z.number(),
  currency: z.string(),
  credits: z.array(z.object({ amount: z.number() })).optional(),
  usage: z.object({ amount: z.number() }),
});

export type ClaudeUsageRow = z.infer<typeof claudeUsageRow>;
export type ClaudeCostRow = z.infer<typeof claudeCostRow>;
export type GeminiRow = z.infer<typeof geminiRow>;

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown, where: string): z.infer<T> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const i = r.error.issues[0]!;
  throw new ExportError(`${where}: ${[...i.path].join(".") || "<row>"}: ${i.message}`);
}

const dataRows = <T extends z.ZodTypeAny>(row: T, label: string) => (file: unknown): z.infer<T>[] => {
  const data = (file as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new ExportError(`${label}: expected a "data" array`);
  return data.map((item, i) => {
    const r = row.safeParse(item);
    if (r.success) return r.data;
    const issue = r.error.issues[0]!;
    throw new ExportError(`${label}: data.${i}.${issue.path.join(".") || "<row>"}: ${issue.message}`);
  });
};

export const parseClaudeUsage = dataRows(claudeUsageRow, "claude usage report");
export const parseClaudeCost = dataRows(claudeCostRow, "claude cost report");

export function parseGeminiLine(line: string, lineNumber: number): GeminiRow {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new ExportError(`gemini billing export: line ${lineNumber}: not valid JSON`);
  }
  return parse(geminiRow, json, `gemini billing export: line ${lineNumber}`);
}

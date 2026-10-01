import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    reason: string,
  ) {
    super(reason);
  }
}

export function parseQuery<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new HttpError(422, "invalid_request", r.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; "));
  }
  return r.data;
}

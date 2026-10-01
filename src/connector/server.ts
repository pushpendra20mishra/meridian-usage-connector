import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import contract from "../../contracts/tools.schema.json" with { type: "json" };
import type { User } from "../core/directory.js";
import { type DenialBody, Denied, type Policy, type Scope } from "../core/policy.js";
import type { ServiceClient } from "./service.js";

export interface Deps {
  user: User;
  policy: Policy;
  service: ServiceClient;
  groups: readonly string[];
}

// enums and bounds come straight from the contract
const enumOf = (values: readonly string[]) => z.enum(values as [string, ...string[]]);
const CAPABILITIES = contract.$defs.Capability.enum;
const PERIOD = new RegExp(contract.$defs.Period.pattern);
const LIMIT = contract.tools.top_users.input.properties.limit;

type Payload = Record<string, unknown> | unknown[];
type ErrorBody = { error: "service_error" | "service_unavailable"; reason: string; status?: number };
type Result = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// arrays get wrapped because structuredContent has to be an object
const ok = (data: Payload): Result => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: Array.isArray(data) ? { results: data } : data,
});
// errors are text only, strict clients reject structuredContent that does not match the schema
const fail = (body: DenialBody | ErrorBody): Result => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  isError: true,
});

const isDenial = (b: unknown): b is DenialBody =>
  typeof b === "object" && b !== null && (b as { error?: unknown }).error === "permission_denied";
const connectorEnabled = (rows: unknown): boolean =>
  Array.isArray(rows) &&
  rows.some((r) => r?.capability === "usage-connector" && r?.enabled === true);

class Failure extends Error {
  constructor(public result: Result) {
    super("failure");
  }
}

type Request = { method: "GET" | "PUT"; path: string; body?: unknown };
const query = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
  ).toString();

interface ToolSpec<S extends z.ZodRawShape & { group: z.ZodType<string | undefined> }> {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  input: S;
  output: z.ZodRawShape;
  readOnly: boolean;
  request: (args: z.objectOutputType<S, z.ZodTypeAny>, group: string) => Request;
}

export function createServer(deps: Deps): McpServer {
  const { user, policy, service } = deps;
  const server = new McpServer({ name: "meridian-usage", version: "0.1.0" });

  const group = enumOf(deps.groups);
  const optionalGroup = group
    .optional()
    .describe("Group to report on. Omit for your own group. Team leads may only name their own group.");
  const period = z
    .string()
    .regex(PERIOD)
    .describe(
      "last_7_days, last_30_days, an ISO week such as 2026-W36, or a month such as 2026-09. " +
        "Data ends 2026-09-28, so the last full month is 2026-08 and 2026-09 is partial.",
    );

  async function call({ method, path, body }: Request) {
    try {
      return await service.request(method, path, body);
    } catch (e) {
      throw new Failure(
        fail({ error: "service_unavailable", reason: `usage service unreachable: ${(e as Error).message}` }),
      );
    }
  }

  // the per-group usage-connector switch, as the service sees it for this user
  async function requireConnectorEnabled(): Promise<void> {
    const own = await call({ method: "GET", path: "/api/v1/capabilities/self" });
    // pass the service denial through, eg suspended
    if (own.status === 403 && isDenial(own.body)) throw new Denied(own.body.reason, own.body.required_scope);
    if (own.status !== 200 || !connectorEnabled(own.body)) {
      throw new Denied(`the usage-connector capability is disabled for group '${user.groupIds[0]}'; ask a platform admin to enable it`);
    }
  }

  async function authorise(scope: Scope, requested: string | undefined): Promise<string> {
    const target = policy.resolveGroup(user, scope, requested);
    await requireConnectorEnabled();
    return target;
  }

  async function fetchData(req: Request): Promise<Result> {
    const r = await call(req);
    if (r.status === 200) return ok(r.body as Payload);
    if (r.status === 403 && isDenial(r.body)) return fail(r.body);
    return fail({ error: "service_error", status: r.status, reason: JSON.stringify(r.body).slice(0, 300) });
  }

  function defineTool<S extends z.ZodRawShape & { group: z.ZodType<string | undefined> }>(spec: ToolSpec<S>) {
    const handler = async (args: z.objectOutputType<S, z.ZodTypeAny>): Promise<Result> => {
      try {
        const g = await authorise(spec.scope, args.group);
        return await fetchData(spec.request(args, g));
      } catch (e) {
        if (e instanceof Denied) return fail(e.body());
        if (e instanceof Failure) return e.result;
        throw e;
      }
    };
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input,
        outputSchema: spec.output,
        annotations: {
          readOnlyHint: spec.readOnly,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      // sdk cant infer the handler type through the generic, hence the cast
      handler as unknown as Parameters<typeof server.registerTool>[2],
    );
  }

  const capabilityState = {
    group: z.string(),
    capability: enumOf(CAPABILITIES),
    enabled: z.boolean(),
    updated_at: z.string().nullable().optional(),
    updated_by: z.string().nullable().optional(),
  };

  defineTool({
    name: "usage_summary",
    title: "Usage summary",
    description:
      "Tokens and cost in USD for one group over a period, split by platform (Claude, Gemini) with totals. " +
      "Read-only. For per-person detail use top_users.",
    scope: "usage:read",
    readOnly: true,
    input: { group: optionalGroup, period },
    output: {
      group: z.string(),
      period: z.object({ start: z.string(), end_exclusive: z.string(), partial: z.boolean().optional() }),
      platforms: z.array(z.object({ platform: z.enum(["claude", "gemini"]), requests: z.number().nullable() }).passthrough()),
      totals: z.object({ total_tokens: z.number(), cost_usd: z.number() }),
    },
    request: (a, group) => ({ method: "GET", path: `/api/v1/usage/summary?${query({ group, period: a.period })}` }),
  });

  defineTool({
    name: "top_users",
    title: "Top users",
    description: `Users in one group ranked by total tokens over a period, with cost in USD. Read-only. Max ${LIMIT.maximum}.`,
    scope: "usage:read",
    readOnly: true,
    input: {
      group: optionalGroup,
      period,
      limit: z.number().int().min(LIMIT.minimum).max(LIMIT.maximum).default(LIMIT.default)
        .describe(`How many users to return (${LIMIT.minimum}-${LIMIT.maximum}).`),
    },
    output: {
      results: z.array(z.object({ user_id: z.string(), name: z.string(), group: z.string(), total_tokens: z.number(), cost_usd: z.number() }).passthrough()),
    },
    request: (a, group) => ({ method: "GET", path: `/api/v1/usage/top-users?${query({ group, period: a.period, limit: a.limit })}` }),
  });

  defineTool({
    name: "capability_status",
    title: "Capability status",
    description: `Whether each capability (${CAPABILITIES.join(", ")}) is enabled for a group. Read-only.`,
    scope: "usage:read",
    readOnly: true,
    input: { group: optionalGroup },
    output: { results: z.array(z.object(capabilityState)) },
    request: (_a, group) => ({ method: "GET", path: `/api/v1/capabilities?${query({ group })}` }),
  });

  defineTool({
    name: "set_capability",
    title: "Set capability",
    description:
      "Enable or disable one capability for one group. Changes persisted state and is recorded with the caller " +
      "and time. Requires the capabilities:write scope (platform admins).",
    scope: "capabilities:write",
    readOnly: false,
    input: {
      group: group.describe("Group whose capability to change."),
      capability: enumOf(CAPABILITIES).describe("Capability to change."),
      enabled: z.boolean().describe("true to enable, false to disable."),
    },
    output: { ...capabilityState, updated_at: z.string(), updated_by: z.string() },
    request: (a, group) => ({
      method: "PUT",
      path: `/api/v1/capabilities/${group}/${a.capability}`,
      body: { enabled: a.enabled },
    }),
  });

  return server;
}

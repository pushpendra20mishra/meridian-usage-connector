import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Directory, User } from "../core/directory.js";
import { type DateRange, parsePeriod } from "../core/periods.js";
import { Denied, type Policy, type Scope } from "../core/policy.js";
import type { AuditLog } from "./audit.js";
import type { CapabilityStore } from "./capabilities.js";
import type { Db } from "./db.js";
import { HttpError } from "./http.js";
import { dataEndExclusive } from "./queries.js";
import type { UserAdmin } from "./users.js";

export interface AppContext {
  directory: Directory;
  policy: Policy;
  db: Db;
  caps: CapabilityStore;
  audit: AuditLog;
  users: UserAdmin;
  names: Map<string, { name: string; email: string }>;
  uiDefaultUser: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    caller: User;
  }
}

// simulated identity, a real deployment would verify a token here
function callerOf(ctx: AppContext, header: string | string[] | undefined): User {
  const ref = Array.isArray(header) ? header[0] : header;
  const user = ref ? ctx.directory.user(ref) : undefined;
  if (!user) throw new HttpError(401, "unauthenticated", "X-Meridian-User must be a user_id or email in the directory");
  // suspended users are refused before anything else
  if (ctx.users.suspension(user.userId)) throw new Denied("your account is suspended by a platform admin; contact the platform team");
  return user;
}

// every route registered inside this scope needs a known, active caller, however its url is spelled
export function requireCaller(app: FastifyInstance, ctx: AppContext) {
  app.addHook("preHandler", async (req) => {
    req.caller = callerOf(ctx, req.headers["x-meridian-user"]);
  });
}

export function groupFor(ctx: AppContext, req: FastifyRequest, scope: Scope, requested: string | undefined): string {
  if (requested !== undefined && !ctx.directory.group(requested)) throw new HttpError(422, "invalid_request", `unknown group ${JSON.stringify(requested)}`);
  return ctx.policy.resolveGroup(req.caller, scope, requested);
}

export function resolvePeriod(ctx: AppContext, period: string): { range: DateRange; json: Record<string, unknown> } {
  const range = parsePeriod(period, dataEndExclusive(ctx.db));
  return { range, json: { start: range.start, end_exclusive: range.endExclusive, ...(range.partial ? { partial: true } : {}) } };
}

export const requireAdmin = (ctx: AppContext, req: FastifyRequest, scope: Scope) => ctx.policy.requireAllGroups(req.caller, scope);

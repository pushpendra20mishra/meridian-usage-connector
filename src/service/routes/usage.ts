import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { weekStart } from "../../core/periods.js";
import { type AppContext, groupFor, resolvePeriod } from "../context.js";
import { parseQuery } from "../http.js";
import * as queries from "../queries.js";

const DIMS = ["platform", "group", "week"] as const;
const base = { period: z.string(), group: z.string().optional() };
const dims = z
  .union([z.enum(DIMS), z.array(z.enum(DIMS))])
  .optional()
  .transform((v): queries.Dim[] => (v === undefined ? ["platform"] : [...new Set(Array.isArray(v) ? v : [v])]));

export function usageRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/v1/usage/summary", async (req) => {
    const q = parseQuery(z.object(base), req.query);
    const group = groupFor(ctx, req, "usage:read", q.group);
    const { range, json } = resolvePeriod(ctx, q.period);
    return { ...queries.summary(ctx.db, range, group), period: json };
  });

  app.get("/api/v1/usage", async (req) => {
    const q = parseQuery(z.object({ ...base, by: dims }), req.query);
    const groups = q.group !== undefined ? [groupFor(ctx, req, "usage:read", q.group)] : ctx.policy.defaultGroups(req.caller, "usage:read", ctx.directory.groupIds);
    const { range, json } = resolvePeriod(ctx, q.period);
    const rows = queries.breakdown(ctx.db, range, groups, q.by).map((r) => (r.week ? { ...r, week_start: weekStart(r.week) } : r));
    return { period: json, by: q.by, groups, rows };
  });

  app.get("/api/v1/usage/top-users", async (req) => {
    const q = parseQuery(z.object({ ...base, limit: z.coerce.number().int().min(1).max(25).default(10) }), req.query);
    const group = groupFor(ctx, req, "usage:read", q.group);
    return queries.topUsers(ctx.db, resolvePeriod(ctx, q.period).range, group, q.limit, ctx.names);
  });

  app.get("/api/v1/usage/by-user", async (req) => {
    const q = parseQuery(z.object(base), req.query);
    const group = groupFor(ctx, req, "usage:read", q.group);
    const members = ctx.directory.users.filter((u) => u.groupIds.includes(group));
    return queries.byUser(ctx.db, resolvePeriod(ctx, q.period).range, members, group);
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../context.js";
import { parseQuery } from "../http.js";
import * as queries from "../queries.js";

export function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  const { policy, directory } = ctx;

  // admins also get the per-user actions, everyone else only switch changes in groups they can write
  app.get("/api/v1/admin/audit", async (req) => {
    const { limit } = parseQuery(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    policy.requireScope(req.caller, "capabilities:write");
    const scope = policy.hasAllGroups(req.caller, "capabilities:write") ? "all" : policy.visibleGroups(req.caller, "capabilities:write", directory.groupIds);
    return ctx.audit.list(scope, limit);
  });

  app.get("/api/v1/admin/data-health", async (req) => {
    requireAdmin(ctx, req, "capabilities:write");
    return queries.dataHealth(ctx.db);
  });
}

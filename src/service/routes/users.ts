import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, requireAdmin, resolvePeriod } from "../context.js";
import { HttpError, parseQuery } from "../http.js";
import * as queries from "../queries.js";

export function userRoutes(app: FastifyInstance, ctx: AppContext) {
  const { policy, users, directory } = ctx;
  const target = (req: { params: unknown }) => {
    const id = (req.params as { userId: string }).userId;
    const user = directory.user(id);
    if (!user) throw new HttpError(404, "not_found", `no such user ${JSON.stringify(id)}`);
    return user;
  };

  app.get("/api/v1/admin/users/:userId/usage", async (req) => {
    requireAdmin(ctx, req, "usage:read");
    const user = target(req);
    const { period } = parseQuery(z.object({ period: z.string() }), req.query);
    const { range, json } = resolvePeriod(ctx, period);
    return {
      user: { user_id: user.userId, name: user.name, email: user.email, role: user.role, group: user.groupIds[0] },
      period: json,
      ...queries.userUsage(ctx.db, range, user.userId),
    };
  });

  app.get("/api/v1/admin/users/:userId/capabilities", async (req) => {
    requireAdmin(ctx, req, "usage:read");
    return users.effective(target(req));
  });

  // enabled null clears the override
  app.put("/api/v1/admin/users/:userId/capabilities/:capability", async (req) => {
    requireAdmin(ctx, req, "capabilities:write");
    const user = target(req);
    const capability = (req.params as { capability: string }).capability;
    const body = parseQuery(z.object({ enabled: z.boolean().nullable() }), req.body);
    if (!policy.capabilities.includes(capability)) throw new HttpError(422, "invalid_request", `unknown capability ${JSON.stringify(capability)}`);
    return users.setOverride(user, capability, body.enabled, req.caller.email);
  });

  app.put("/api/v1/admin/users/:userId/suspension", async (req) => {
    requireAdmin(ctx, req, "capabilities:write");
    const user = target(req);
    const body = parseQuery(z.object({ suspended: z.boolean(), reason: z.string().max(200).optional() }), req.body);
    if (body.suspended && user.userId === req.caller.userId) throw new HttpError(422, "invalid_request", "you cannot suspend your own account");
    if (body.suspended) return users.suspend(user, body.reason?.trim() || null, req.caller.email);
    users.restore(user, req.caller.email);
    return { user_id: user.userId, suspended: false };
  });

  app.get("/api/v1/admin/users/suspensions", async (req) => {
    requireAdmin(ctx, req, "usage:read");
    return users.suspensions();
  });
}

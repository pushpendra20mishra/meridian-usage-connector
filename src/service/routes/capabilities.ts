import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, groupFor } from "../context.js";
import { HttpError, parseQuery } from "../http.js";

export function capabilityRoutes(app: FastifyInstance, ctx: AppContext) {
  const { policy, caps, directory } = ctx;

  app.get("/api/v1/capabilities", async (req) => {
    const { group } = parseQuery(z.object({ group: z.string().optional() }), req.query);
    return caps.status(groupFor(ctx, req, "usage:read", group));
  });

  app.get("/api/v1/capabilities/matrix", async (req) => {
    const groups = policy.defaultGroups(req.caller, "usage:read", directory.groupIds);
    const writable = new Set(policy.visibleGroups(req.caller, "capabilities:write", directory.groupIds));
    return {
      capabilities: policy.capabilities,
      groups: caps.matrix(groups).map((row) => ({ ...row, can_write: writable.has(row.group) })),
    };
  });

  // own switches only, so no scope needed. the connector reads this
  app.get("/api/v1/capabilities/self", async (req) => ctx.users.effective(req.caller));

  app.put("/api/v1/capabilities/:group/:capability", async (req) => {
    const { group, capability } = req.params as { group: string; capability: string };
    const body = parseQuery(z.object({ enabled: z.boolean() }), req.body);
    if (!policy.capabilities.includes(capability)) throw new HttpError(422, "invalid_request", `unknown capability ${JSON.stringify(capability)}`);
    return caps.set(groupFor(ctx, req, "capabilities:write", group), capability, body.enabled, req.caller.email);
  });
}

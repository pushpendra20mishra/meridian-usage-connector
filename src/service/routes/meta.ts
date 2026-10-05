import { readFileSync } from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppContext } from "../context.js";
import { one } from "../db.js";

const asset = (name: string) => readFileSync(new URL(`../static/${name}`, import.meta.url), "utf8");

// open on purpose: the page itself, health, and the list behind the user switcher
export function publicRoutes(app: FastifyInstance, ctx: AppContext) {
  const page = (_: unknown, reply: FastifyReply) => reply.type("text/html; charset=utf-8").send(asset("admin.html"));
  app.get("/", page);
  app.get("/admin", page);
  app.get("/admin.js", async (_, reply) => reply.type("text/javascript; charset=utf-8").send(asset("admin.js")));

  app.get("/health", async () => ({
    status: "ok",
    environment: ctx.policy.environment,
    ingest_issues: one<{ c: number }>(ctx.db, "SELECT COUNT(*) c FROM ingest_issue")!.c,
  }));

  app.get("/api/v1/identities", async () => ({
    default_user: ctx.uiDefaultUser,
    users: ctx.directory.users.map((u) => ({ user_id: u.userId, email: u.email, name: u.name, role: u.role, groups: u.groupIds })),
  }));
}

export function sessionRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/v1/me", async (req) => {
    const user = req.caller;
    const { policy, directory } = ctx;
    return {
      user_id: user.userId, email: user.email, name: user.name, role: user.role, groups: user.groupIds,
      environment: policy.environment,
      scopes: (["usage:read", "capabilities:write"] as const).filter((s) => policy.hasScope(user, s)),
      readable_groups: policy.visibleGroups(user, "usage:read", directory.groupIds),
      writable_groups: policy.visibleGroups(user, "capabilities:write", directory.groupIds),
    };
  });
}

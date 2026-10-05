import Fastify from "fastify";
import { loadDirectory } from "../core/directory.js";
import { InvalidPeriod } from "../core/periods.js";
import { Denied, Policy } from "../core/policy.js";
import { readFileSync } from "node:fs";
import { AuditLog } from "./audit.js";
import { CapabilityStore, seedDefaults } from "./capabilities.js";
import { type Settings } from "./config.js";
import { type AppContext, requireCaller } from "./context.js";
import { HttpError } from "./http.js";
import { openDb } from "./db.js";
import * as ingest from "./ingest.js";
import { UserAdmin } from "./users.js";
import { adminRoutes } from "./routes/admin.js";
import { userRoutes } from "./routes/users.js";
import { capabilityRoutes } from "./routes/capabilities.js";
import { publicRoutes, sessionRoutes } from "./routes/meta.js";
import { usageRoutes } from "./routes/usage.js";

export async function createApp(settings: Settings) {
  const directory = loadDirectory(`${settings.dataDir}/directory`);
  const policy = new Policy(JSON.parse(readFileSync(settings.permissionsPath, "utf8")));
  const db = openDb(settings.dbPath);
  if (ingest.needsIngest(db)) ingest.run(db, settings.dataDir, directory);
  seedDefaults(db, policy, directory.groupIds);

  const names = new Map(directory.users.map((u) => [u.userId, { name: u.name, email: u.email }]));
  const audit = new AuditLog(db, names);
  const caps = new CapabilityStore(db, policy.capabilities, audit);
  const ctx: AppContext = {
    directory, policy, db, caps, audit,
    users: new UserAdmin(db, caps, audit),
    names,
    uiDefaultUser: (settings.uiDefaultUser && directory.user(settings.uiDefaultUser)?.email) || null,
  };

  const app = Fastify({ logger: false });
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof Denied) return reply.code(403).send(err.body());
    if (err instanceof InvalidPeriod) return reply.code(422).send({ error: "invalid_period", reason: err.message });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, reason: err.message });
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation || e.statusCode === 400) return reply.code(422).send({ error: "invalid_request", reason: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: "internal_error", reason: "unexpected error" });
  });
  app.addHook("onClose", async () => { db.close(); });

  app.decorateRequest("caller");
  publicRoutes(app, ctx);
  app.register(async (protectedScope) => {
    requireCaller(protectedScope, ctx);
    for (const register of [sessionRoutes, usageRoutes, capabilityRoutes, adminRoutes, userRoutes]) register(protectedScope, ctx);
  });
  await app.ready();
  return app;
}

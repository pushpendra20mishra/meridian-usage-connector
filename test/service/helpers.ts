import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createApp } from "../../src/service/app.js";
import { type Env, DIST, ROOT } from "../helpers.js";

export { raw } from "../helpers.js";

export interface Reply {
  status: number;
  json: any;
}

export interface TestClient {
  app: Awaited<ReturnType<typeof createApp>>;
  dbPath: string;
  get(url: string, user?: string): Promise<Reply>;
  put(url: string, user: string | undefined, body: unknown): Promise<Reply>;
  // same db file, like a restart
  restart(): Promise<TestClient>;
}

const open: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()));
});

export async function makeClient(env: Env = "prod", dbPath?: string, extra: { uiDefaultUser?: string } = {}): Promise<TestClient> {
  const path = dbPath ?? join(mkdtempSync(join(tmpdir(), "meridian-test-")), `${env}.sqlite`);
  const app = await createApp({ dataDir: `${ROOT}/data`, dbPath: path, permissionsPath: `${DIST}/${env}/permissions.json`, ...extra });
  open.push(app);
  const call = async (method: "GET" | "PUT", url: string, user?: string, body?: unknown): Promise<Reply> => {
    const r = await app.inject({
      method, url,
      headers: { ...(user ? { "x-meridian-user": user } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null };
  };
  return {
    app, dbPath: path,
    get: (url, user) => call("GET", url, user),
    put: (url, user, body) => call("PUT", url, user, body),
    restart: () => makeClient(env, path, extra),
  };
}

export const ADMIN = "chloe.dubois@meridianls.example";
export const LEAD = "priya.nair@meridianls.example"; // clinical-operations
export const FIN_LEAD = "sofia.rossi@meridianls.example";
export const MEMBER = "daniel.okafor@meridianls.example";

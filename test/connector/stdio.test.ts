import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DIST, ROOT, text } from "./helpers.js";
import { type RunningService, startService } from "./service-process.js";

const BUNDLE = `${ROOT}/bundle/server.mjs`;
let svc: RunningService;

const launch = (user: string, env = "prod", extra: Record<string, string> = {}) =>
  new StdioClientTransport({
    command: "node",
    args: [BUNDLE],
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      MERIDIAN_ENV: env,
      MERIDIAN_USER: user,
      MERIDIAN_SERVICE_URL: svc?.url ?? "http://127.0.0.1:1",
      MERIDIAN_PERMISSIONS: `${DIST}/${env}/permissions.json`,
      MERIDIAN_DIRECTORY: `${ROOT}/data/directory`,
      ...extra,
    },
  });

beforeAll(async () => {
  execFileSync("npm", ["run", "bundle", "--silent"], { cwd: ROOT });
  svc = await startService("prod", 18090);
}, 60_000);
afterAll(() => svc?.stop());

describe("stdio entrypoint", () => {
  it("starts as the configured user and enforces scope end to end", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(launch("priya.nair@meridianls.example"));
    const ok = await client.callTool({ name: "usage_summary", arguments: { period: "2026-08" } });
    expect(ok.isError).toBeFalsy();
    expect(text(ok).group).toBe("clinical-operations");
    const denied = await client.callTool({ name: "usage_summary", arguments: { period: "2026-08", group: "finance" } });
    expect(denied.isError).toBe(true);
    expect(text(denied).error).toBe("permission_denied");
    const write = await client.callTool({ name: "set_capability", arguments: { group: "clinical-operations", capability: "web-search", enabled: false } });
    expect(text(write)).toMatchObject({ error: "permission_denied", required_scope: "capabilities:write" });
    await client.close();
  }, 30_000);

  it("refuses to start for a user who is not in the directory", async () => {
    const client = new Client({ name: "t", version: "0" });
    await expect(client.connect(launch("ghost@nowhere.example"))).rejects.toThrow();
  });

  it("refuses to start without an identity", async () => {
    const client = new Client({ name: "t", version: "0" });
    await expect(client.connect(launch(""))).rejects.toThrow();
  });
});

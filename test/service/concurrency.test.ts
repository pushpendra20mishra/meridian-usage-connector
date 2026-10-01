import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createApp } from "../../src/service/app.js";
import { DIST, ROOT } from "../helpers.js";
import { ADMIN } from "./helpers.js";

let app: Awaited<ReturnType<typeof createApp>>;
afterAll(() => app?.close());

it("300 mixed parallel requests all succeed", async () => {
  app = await createApp({ dataDir: `${ROOT}/data`, dbPath: join(mkdtempSync(join(tmpdir(), "meridian-")), "c.sqlite"), permissionsPath: `${DIST}/staging/permissions.json` });
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const headers = { "x-meridian-user": ADMIN, "content-type": "application/json" };
  const reqs = Array.from({ length: 300 }, (_, i) =>
    i % 2
      ? fetch(`${base}/api/v1/capabilities/finance/web-search`, { method: "PUT", headers, body: JSON.stringify({ enabled: i % 4 === 1 }) })
      : fetch(`${base}/api/v1/usage?period=2026-08&by=week&by=group`, { headers }),
  );
  const statuses = (await Promise.all(reqs)).map((r) => r.status);
  expect(statuses.filter((s) => s !== 200)).toEqual([]);
});

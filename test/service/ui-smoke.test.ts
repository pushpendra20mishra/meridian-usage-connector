import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/service/app.js";
import { DIST, ROOT } from "../helpers.js";

const which = (b: string) => { try { return execFileSync("which", [b], { encoding: "utf8" }).trim(); } catch { return ""; } };
const CHROME = which("google-chrome") || which("chromium") || which("chromium-browser");
let app: Awaited<ReturnType<typeof createApp>>;
afterAll(() => app?.close());

// async, the server lives in this process
const run = promisify(execFile);
const dom = async (base: string) =>
  (await run(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--virtual-time-budget=8000", "--dump-dom", `${base}/admin`], { encoding: "utf8", timeout: 60_000 }))
    .stdout.replace(/<script[\s\S]*?<\/script>/g, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe.skipIf(!CHROME)("admin page (headless Chrome)", () => {
  async function base(defaultUser: string) {
    app = await createApp({ dataDir: `${ROOT}/data`, dbPath: join(mkdtempSync(join(tmpdir(), "meridian-")), "u.sqlite"), permissionsPath: `${DIST}/prod/permissions.json`, uiDefaultUser: defaultUser });
    return app.listen({ port: 0, host: "127.0.0.1" });
  }
  it("admin sees everything", async () => {
    const html = await dom(await base("chloe.dubois@meridianls.example"));
    expect(text(html)).toContain("Total cost");
    expect(text(html)).toContain("$1,045.27");
    expect(new Set([...html.matchAll(/data-group="([^"]+)"/g)].map((m) => m[1])).size).toBe(6);
    expect(html).toContain("Change log");
    expect(html).toContain("Data health");
    expect(html).not.toMatch(/id="manage-card"[^>]*hidden/);
    expect(new Set([...html.matchAll(/<option value="(user_[^"]+)"/g)].map((m) => m[1])).size).toBe(22);
    expect(html).not.toContain("Unavailable");
    expect(text(html)).not.toMatch(/is not a function|undefined|NaN/);
    expect(text(html)).toContain("Capabilities for this user");
    expect(text(html)).toContain("Usage in the selected period");
    expect([...html.matchAll(/class="mu-cap"/g)].length).toBe(3);
    expect(html).toContain('id="mu-suspend"');
    await app.close();
  });
  it("team lead sees own group with read-only switches", async () => {
    const html = await dom(await base("priya.nair@meridianls.example"));
    expect(new Set([...html.matchAll(/data-group="([^"]+)"/g)].map((m) => m[1]))).toEqual(new Set(["clinical-operations"]));
    const switches = html.match(/<button class="switch"[^>]*>/g) ?? [];
    expect(switches.length).toBeGreaterThan(0);
    expect(switches.every((s) => s.includes("disabled"))).toBe(true);
    expect(text(html)).toContain("$145.95");
    expect(html).toMatch(/id="manage-card"[^>]*hidden/);
    const users = text(html.match(/<table id="t-users">[\s\S]*?<\/table>/)?.[0] ?? "");
    for (const name of ["Priya Nair", "Daniel Okafor", "Aisha Rahman", "Tomasz Kowalski"]) expect(users).toContain(name);
    expect(users).not.toContain("Sofia Rossi");
    await app.close();
  });
  it("member without scope sees only a clear message", async () => {
    const html = await dom(await base("daniel.okafor@meridianls.example"));
    expect(text(html)).toContain("does not have usage:read");
    expect(html).toContain('id="data" hidden');
    await app.close();
  });
});

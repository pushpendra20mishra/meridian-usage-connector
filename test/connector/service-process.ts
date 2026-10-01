import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIST, ROOT, type Env } from "../helpers.js";

export interface RunningService {
  url: string;
  stop(): void;
}

export async function startService(env: Env, port: number): Promise<RunningService> {
  const proc: ChildProcess = spawn("npx", ["tsx", "src/service/main.ts", "serve", "--port", String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      MERIDIAN_ENV: env,
      MERIDIAN_DB: join(mkdtempSync(join(tmpdir(), "meridian-")), "t.sqlite"),
      MERIDIAN_PERMISSIONS: `${DIST}/${env}/permissions.json`,
      MERIDIAN_DATA_DIR: `${ROOT}/data`,
    },
    stdio: "ignore",
    detached: true,
  });
  const url = `http://127.0.0.1:${port}`;
  const stop = () => { try { process.kill(-proc.pid!); } catch { /* already gone */ } };
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, stop };
    } catch {
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  stop();
  throw new Error(`service for ${env} did not start`);
}

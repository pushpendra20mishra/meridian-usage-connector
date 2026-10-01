import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), "meridian-dist-"));
  const out = join(dir, "dist");
  execFileSync("npx", ["tsx", "src/provisioning/render.ts", "--out", out], { stdio: "pipe" });
  process.env.RENDERED_DIST = out;
  return () => rmSync(dir, { recursive: true, force: true });
}

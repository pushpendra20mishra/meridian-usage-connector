import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDirectory } from "../src/core/directory.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export type Env = "dev" | "staging" | "prod";

// rendered fresh in global-setup, not read from dist/
export const DIST = process.env.RENDERED_DIST ?? `${ROOT}/dist`;
export const manifest = (env: Env) => JSON.parse(readFileSync(`${DIST}/${env}/permissions.json`, "utf8"));
export const directory = () => loadDirectory(`${ROOT}/data/directory`);

export const raw = () => {
  const d = `${ROOT}/data`;
  const json = (f: string) => JSON.parse(readFileSync(`${d}/${f}`, "utf8"));
  return {
    usage: json("claude/user_usage_report.json"),
    cost: json("claude/user_cost_report.json"),
    gemini: readFileSync(`${d}/gemini/gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9.jsonl`, "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    users: json("directory/users.json").users,
    groups: json("directory/groups.json").groups,
  };
};

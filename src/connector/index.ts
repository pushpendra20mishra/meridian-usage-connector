#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadDirectory } from "../core/directory.js";
import { Policy } from "../core/policy.js";
import { createServer } from "./server.js";
import { HttpServiceClient } from "./service.js";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`meridian-usage: ${name} is required`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const email = required("MERIDIAN_USER");
  const directory = loadDirectory(required("MERIDIAN_DIRECTORY"));
  // role and groups come from the directory, not the config
  const user = directory.user(email);
  if (!user) {
    console.error(`meridian-usage: '${email}' is not in the directory; refusing to start`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(required("MERIDIAN_PERMISSIONS"), "utf8"));
  if (process.env.MERIDIAN_ENV && manifest.environment !== process.env.MERIDIAN_ENV) {
    console.error(`meridian-usage: manifest is for '${manifest.environment}', MERIDIAN_ENV is '${process.env.MERIDIAN_ENV}'`);
    process.exit(1);
  }
  const server = createServer({
    user,
    policy: new Policy(manifest),
    service: new HttpServiceClient(required("MERIDIAN_SERVICE_URL"), user.email),
    groups: directory.groupIds,
  });
  await server.connect(new StdioServerTransport());
  console.error(`meridian-usage[${manifest.environment}] running as ${user.email} (${user.role})`); // stderr only, stdout is the protocol
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { loadDirectory } from "../core/directory.js";
import { createApp } from "./app.js";
import { settingsFromEnv } from "./config.js";
import { openDb } from "./db.js";
import * as ingest from "./ingest.js";

const [cmd = "serve", ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string) => (rest.includes(name) ? rest[rest.indexOf(name) + 1]! : fallback);
const settings = settingsFromEnv();

if (cmd === "ingest") {
  const res = ingest.run(openDb(settings.dbPath), settings.dataDir, loadDirectory(`${settings.dataDir}/directory`));
  console.log(`ingested ${res.facts.length} facts, ${res.issues.length} issues -> ${settings.dbPath}`);
  for (const i of res.issues.slice(0, 20)) console.log(`  issue [${i.source}] ${i.ref}: ${i.reason}`);
} else if (cmd === "serve") {
  const app = await createApp(settings);
  const address = await app.listen({ host: flag("--host", "127.0.0.1"), port: Number(flag("--port", "8080")) });
  console.log(`meridian usage service listening on ${address}`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}

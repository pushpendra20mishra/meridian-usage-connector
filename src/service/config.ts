import { join } from "node:path";

export interface Settings {
  dataDir: string;
  dbPath: string;
  permissionsPath: string;
  uiDefaultUser?: string;
}

// defaults are relative to the cwd
export function settingsFromEnv(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): Settings {
  const name = env.MERIDIAN_ENV ?? "dev";
  return {
    dataDir: env.MERIDIAN_DATA_DIR ?? join(cwd, "data"),
    dbPath: env.MERIDIAN_DB ?? join(cwd, "var", `${name}.sqlite`),
    permissionsPath: env.MERIDIAN_PERMISSIONS ?? join(cwd, "dist", name, "permissions.json"),
    uiDefaultUser: env.MERIDIAN_UI_DEFAULT_USER,
  };
}

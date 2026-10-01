import { describe, expect, it } from "vitest";
import { settingsFromEnv } from "../../src/service/config.js";

describe("settings", () => {
  it("defaults are relative to the working directory", () => {
    const s = settingsFromEnv({ MERIDIAN_ENV: "staging" }, "/work");
    expect(s).toEqual({ dataDir: "/work/data", dbPath: "/work/var/staging.sqlite", permissionsPath: "/work/dist/staging/permissions.json", uiDefaultUser: undefined });
  });
  it("environment variables override", () => {
    expect(settingsFromEnv({ MERIDIAN_DATA_DIR: "/d", MERIDIAN_DB: "/x.sqlite", MERIDIAN_PERMISSIONS: "/p.json" }, "/work")).toEqual({
      dataDir: "/d", dbPath: "/x.sqlite", permissionsPath: "/p.json", uiDefaultUser: undefined,
    });
  });
  it("the admin page's default identity is configuration, not a URL parameter", () => {
    expect(settingsFromEnv({ MERIDIAN_UI_DEFAULT_USER: "priya.nair@meridianls.example" }, "/w").uiDefaultUser).toBe("priya.nair@meridianls.example");
  });
});

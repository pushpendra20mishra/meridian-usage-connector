import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDirectory } from "../../src/core/directory.js";
import { directory } from "../helpers.js";

describe("directory", () => {
  it("resolves by email (case-insensitive) or user_id and takes role + groups from the directory", () => {
    const d = directory();
    const u = d.user("PRIYA.NAIR@meridianls.example")!;
    expect(u.role).toBe("team_lead");
    expect(u.groupIds).toEqual(["clinical-operations"]);
    expect(d.user(u.userId)!.email).toBe("priya.nair@meridianls.example");
    expect(d.user("ghost@nowhere.example")).toBeUndefined();
    expect(d.groupIds).toHaveLength(6);
  });
});

describe("directory files are validated", () => {
  const write = (users: unknown, groups: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "dir-"));
    writeFileSync(`${dir}/users.json`, JSON.stringify(users));
    writeFileSync(`${dir}/groups.json`, JSON.stringify(groups));
    return dir;
  };
  const group = { group_id: "g", name: "G", team_lead_user_id: "u", claude_rbac_group_id: "r", gcp_project_id: "p" };
  const user = { user_id: "u", email: "u@x.example", name: "U", role: "member", group_ids: ["g"] };

  it("loads a well-formed directory", () => {
    expect(loadDirectory(write({ users: [user] }, { groups: [group] })).user("u@x.example")?.role).toBe("member");
  });
  it("names the user and field when one is malformed", () => {
    const { role, ...noRole } = user;
    expect(() => loadDirectory(write({ users: [noRole] }, { groups: [group] }))).toThrow(/users\.0\.role/);
    expect(() => loadDirectory(write({ users: [{ ...user, group_ids: [] }] }, { groups: [group] }))).toThrow(/group_ids/);
    expect(() => loadDirectory(write({ users: [user] }, { groups: [{ ...group, gcp_project_id: undefined }] }))).toThrow(/groups\.0\.gcp_project_id/);
  });
  it("rejects a user that belongs to a group the directory does not have", () => {
    expect(() => loadDirectory(write({ users: [{ ...user, group_ids: ["nope"] }] }, { groups: [group] }))).toThrow(/unknown group/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export interface User {
  userId: string;
  email: string;
  name: string;
  role: string;
  groupIds: string[];
}

export interface Group {
  groupId: string;
  name: string;
  teamLeadUserId: string;
  claudeRbacGroupId: string;
  gcpProjectId: string;
}

export class Directory {
  private byId = new Map<string, User>();
  private byEmail = new Map<string, User>();
  private groupsById = new Map<string, Group>();
  private groupsByRbac = new Map<string, Group>();
  private groupsByProject = new Map<string, Group>();

  constructor(
    readonly users: User[],
    readonly groups: Group[],
  ) {
    for (const u of users) {
      this.byId.set(u.userId, u);
      this.byEmail.set(u.email.toLowerCase(), u);
    }
    for (const g of groups) {
      this.groupsById.set(g.groupId, g);
      this.groupsByRbac.set(g.claudeRbacGroupId, g);
      this.groupsByProject.set(g.gcpProjectId, g);
    }
  }

  user(ref: string): User | undefined {
    return this.byId.get(ref) ?? this.byEmail.get(ref.toLowerCase());
  }
  group(id: string): Group | undefined {
    return this.groupsById.get(id);
  }
  groupByRbac(id: string): Group | undefined {
    return this.groupsByRbac.get(id);
  }
  groupByProject(id: string): Group | undefined {
    return this.groupsByProject.get(id);
  }
  get groupIds(): string[] {
    return this.groups.map((g) => g.groupId);
  }
}

const userFile = z.object({
  users: z.array(z.object({ user_id: z.string(), email: z.string(), name: z.string(), role: z.string(), group_ids: z.array(z.string()).min(1) })),
});
const groupFile = z.object({
  groups: z.array(z.object({ group_id: z.string(), name: z.string(), team_lead_user_id: z.string(), claude_rbac_group_id: z.string(), gcp_project_id: z.string() })),
});

function read<T extends z.ZodTypeAny>(dir: string, file: string, schema: T): z.infer<T> {
  const r = schema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
  if (r.success) return r.data;
  const i = r.error.issues[0]!;
  throw new Error(`${file}: ${i.path.join(".")}: ${i.message}`);
}

export function loadDirectory(dir: string): Directory {
  const users: User[] = read(dir, "users.json", userFile).users.map((u) => ({
    userId: u.user_id, email: u.email, name: u.name, role: u.role, groupIds: u.group_ids,
  }));
  const groups: Group[] = read(dir, "groups.json", groupFile).groups.map((g) => ({
    groupId: g.group_id, name: g.name, teamLeadUserId: g.team_lead_user_id,
    claudeRbacGroupId: g.claude_rbac_group_id, gcpProjectId: g.gcp_project_id,
  }));
  const known = new Set(groups.map((g) => g.groupId));
  for (const u of users) {
    const missing = u.groupIds.find((g) => !known.has(g));
    if (missing) throw new Error(`users.json: ${u.email}: unknown group ${JSON.stringify(missing)}`);
  }
  return new Directory(users, groups);
}

import type { User } from "./directory.js";

export type Scope = "usage:read" | "capabilities:write";

interface ScopeSpec {
  roles: string[];
  group_visibility: "own_group" | "all";
  all_groups_roles: string[];
}
export interface Manifest {
  environment: string;
  server_name: string;
  scopes: Record<string, ScopeSpec>;
  capability_defaults: Record<string, Record<string, boolean>>;
}

export type DenialBody = {
  error: "permission_denied";
  reason: string;
  required_scope?: string;
};

export class Denied extends Error {
  constructor(
    public reason: string,
    public requiredScope?: string,
  ) {
    super(reason);
  }
  body(): DenialBody {
    return {
      error: "permission_denied",
      reason: this.reason,
      ...(this.requiredScope ? { required_scope: this.requiredScope } : {}),
    };
  }
}

// one policy module, used by both the service and the connector
export class Policy {
  readonly environment: string;
  constructor(private manifest: Manifest) {
    this.environment = manifest.environment;
  }

  get capabilities(): string[] {
    return Object.keys(this.manifest.capability_defaults);
  }

  capabilityDefault(group: string, capability: string): boolean {
    return this.manifest.capability_defaults[capability]?.[group] === true;
  }

  private spec(scope: string): ScopeSpec | undefined {
    return this.manifest.scopes[scope];
  }

  hasScope(user: User, scope: string): boolean {
    return this.spec(scope)?.roles.includes(user.role) ?? false;
  }

  hasAllGroups(user: User, scope: string): boolean {
    const spec = this.spec(scope);
    return !!spec && spec.roles.includes(user.role) && spec.all_groups_roles.includes(user.role);
  }

  requireScope(user: User, scope: string): void {
    if (!this.hasScope(user, scope)) {
      throw new Denied(`role '${user.role}' does not have the ${scope} scope in ${this.environment}`, scope);
    }
  }

  private canTarget(user: User, scope: string, group: string): boolean {
    const spec = this.spec(scope)!;
    return (
      spec.all_groups_roles.includes(user.role) || spec.group_visibility === "all" || user.groupIds.includes(group)
    );
  }

  resolveGroup(user: User, scope: Scope, group: string | undefined): string {
    this.requireScope(user, scope);
    const target = group ?? user.groupIds[0]!;
    if (!this.canTarget(user, scope, target)) {
      throw new Denied(
        `role '${user.role}' may only access its own group (${user.groupIds[0]}), not another group`,
        scope,
      );
    }
    return target;
  }

  visibleGroups(user: User, scope: Scope, allGroups: readonly string[]): string[] {
    return this.hasScope(user, scope) ? allGroups.filter((g) => this.canTarget(user, scope, g)) : [];
  }

  defaultGroups(user: User, scope: Scope, allGroups: readonly string[]): string[] {
    this.requireScope(user, scope);
    return this.spec(scope)!.all_groups_roles.includes(user.role) ? [...allGroups] : [...user.groupIds];
  }

  requireAllGroups(user: User, scope: Scope): void {
    this.requireScope(user, scope);
    if (!this.hasAllGroups(user, scope)) throw new Denied(`role '${user.role}' may not use platform-wide views`, scope);
  }
}

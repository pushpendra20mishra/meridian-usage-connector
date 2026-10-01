import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Policy } from "../../src/core/policy.js";
import { createServer } from "../../src/connector/server.js";
import type { ServiceClient, ServiceResponse } from "../../src/connector/service.js";
import { DIST, type Env, ROOT, directory, manifest } from "../helpers.js";

export { DIST, ROOT, directory, manifest };
export type { Env };


export class FakeService implements ServiceClient {
  calls: { method: string; path: string }[] = [];
  constructor(private handler: (method: string, path: string) => ServiceResponse) {}
  async request(method: string, path: string): Promise<ServiceResponse> {
    this.calls.push({ method, path });
    return this.handler(method, path);
  }
}

export const allEnabled = (): ServiceResponse => ({
  status: 200,
  body: ["usage-connector", "web-search", "code-execution"].map((capability) => ({
    group: "x", capability, enabled: true, updated_at: null, updated_by: null,
  })),
});

export async function connect(env: Env, email: string, service: ServiceClient) {
  const user = directory().user(email);
  if (!user) throw new Error(`no such user ${email}`);
  const server = createServer({ user, policy: new Policy(manifest(env)), service, groups: directory().groupIds });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

export const text = (r: any): any => JSON.parse(r.content[0].text);

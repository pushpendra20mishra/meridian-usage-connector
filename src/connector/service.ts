export interface ServiceResponse {
  status: number;
  body: unknown;
}

export interface ServiceClient {
  request(method: string, path: string, body?: unknown): Promise<ServiceResponse>;
}

export class HttpServiceClient implements ServiceClient {
  constructor(
    private baseUrl: string,
    private userEmail: string,
    private timeoutMs = 10_000,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<ServiceResponse> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: { "X-Meridian-User": this.userEmail, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { detail: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed };
  }
}

export interface QuotaEnvironment {
  CLIENT_REQUESTS_PER_MINUTE?: string;
  DAILY_REQUEST_LIMIT?: string;
}

export interface QuotaNamespace {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}

export async function reserveQuota(request: Request, namespace: QuotaNamespace, bucket = 'global'): Promise<Response> {
  const day = new Date().toISOString().slice(0, 10);
  const address = request.headers.get('CF-Connecting-IP') ?? 'local';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${day}:${address}`));
  const clientKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return namespace.getByName(bucket).fetch(new Request('https://quota/reserve', {
    method: 'POST', body: JSON.stringify({ clientKey }),
  }));
}

interface QuotaState {
  day: string;
  used: number;
  clients: Record<string, { startedAt: number; count: number }>;
}

export interface QuotaTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface QuotaStorage extends QuotaTransaction {
  transaction<T>(operation: (transaction: QuotaTransaction) => Promise<T>): Promise<T>;
}

export class IntentQuota {
  constructor(
    private readonly state: { storage: QuotaStorage },
    private readonly environment: QuotaEnvironment,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/reserve') {
      return new Response(null, { status: 404 });
    }

    const minuteLimit = Number(this.environment.CLIENT_REQUESTS_PER_MINUTE ?? '5');
    const dailyLimit = Number(this.environment.DAILY_REQUEST_LIMIT ?? '100');
    if (
      !Number.isInteger(minuteLimit) || minuteLimit < 1 || minuteLimit > 1000 ||
      !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10000
    ) {
      return new Response(null, { status: 503 });
    }

    const body = await request.json() as { clientKey?: unknown };
    if (typeof body?.clientKey !== 'string' || !/^[a-f0-9]{64}$/.test(body.clientKey)) {
      return new Response(null, { status: 400 });
    }
    const clientKey = body.clientKey;
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);

    const retryAfter = await this.state.storage.transaction(async (transaction) => {
      let quota = await transaction.get<QuotaState>('quota');
      if (!quota || quota.day !== day) quota = { day, used: 0, clients: {} };
      if (quota.used >= dailyLimit) {
        const tomorrow = Date.parse(`${day}T00:00:00Z`) + 86400000;
        return Math.max(1, Math.ceil((tomorrow - now) / 1000));
      }

      let client = quota.clients[clientKey];
      if (!client || now - client.startedAt >= 60000) client = { startedAt: now, count: 0 };
      if (client.count >= minuteLimit) {
        return Math.max(1, Math.ceil((client.startedAt + 60000 - now) / 1000));
      }

      quota.used += 1;
      client.count += 1;
      quota.clients[clientKey] = client;
      await transaction.put('quota', quota);
      return 0;
    });

    if (retryAfter > 0) {
      return new Response(null, { status: 429, headers: { 'Retry-After': String(retryAfter) } });
    }
    return new Response(null, { status: 204 });
  }
}

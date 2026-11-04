import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntentQuota } from '../quota.js';
import type { QuotaStorage, QuotaTransaction } from '../quota.js';

class MemoryStorage implements QuotaStorage {
  private readonly values = new Map<string, unknown>();
  private pending: Promise<unknown> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  transaction<T>(operation: (transaction: QuotaTransaction) => Promise<T>): Promise<T> {
    const result = this.pending.then(() => operation(this));
    this.pending = result.catch(() => {});
    return result;
  }
}

function reserve(quota: IntentQuota, client = 'a'): Promise<Response> {
  return quota.fetch(new Request('https://quota/reserve', {
    method: 'POST',
    body: JSON.stringify({ clientKey: client.repeat(64) }),
  }));
}

test('applies the client window, while preserving daily usage after a minute', async (t) => {
  let now = Date.parse('2026-11-04T01:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const quota = new IntentQuota({ storage: new MemoryStorage() }, { CLIENT_REQUESTS_PER_MINUTE: '1', DAILY_REQUEST_LIMIT: '2' });
  assert.equal((await reserve(quota)).status, 204);
  const rejected = await reserve(quota);
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get('Retry-After'), '60');
  now += 60000;
  assert.equal((await reserve(quota)).status, 204);
  now += 60000;
  assert.equal((await reserve(quota, 'b')).status, 429);
});

test('enforces the global cap across clients and object re-creation', async () => {
  const storage = new MemoryStorage();
  const quota = new IntentQuota({ storage }, { DAILY_REQUEST_LIMIT: '2' });
  assert.equal((await reserve(quota, 'a')).status, 204);
  assert.equal((await reserve(quota, 'b')).status, 204);
  const restored = new IntentQuota({ storage }, { DAILY_REQUEST_LIMIT: '2' });
  assert.equal((await reserve(restored, 'c')).status, 429);
});

test('resets daily and client usage at the next UTC day', async (t) => {
  let now = Date.parse('2026-11-04T23:59:59Z');
  t.mock.method(Date, 'now', () => now);
  const quota = new IntentQuota({ storage: new MemoryStorage() }, { DAILY_REQUEST_LIMIT: '1' });
  assert.equal((await reserve(quota)).status, 204);
  const rejected = await reserve(quota);
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get('Retry-After'), '1');
  now += 1000;
  assert.equal((await reserve(quota)).status, 204);
});

test('concurrent reservations stop at the configured total', async () => {
  const quota = new IntentQuota({ storage: new MemoryStorage() }, { CLIENT_REQUESTS_PER_MINUTE: '100', DAILY_REQUEST_LIMIT: '7' });
  const responses = await Promise.all(Array.from({ length: 30 }, () => reserve(quota)));
  assert.equal(responses.filter((response) => response.status === 204).length, 7);
  assert.equal(responses.filter((response) => response.status === 429).length, 23);
});

test('rejects invalid quota configuration and internal client keys', async () => {
  for (const configuration of [{ DAILY_REQUEST_LIMIT: '0' }, { CLIENT_REQUESTS_PER_MINUTE: '1.5' }, { DAILY_REQUEST_LIMIT: '10001' }]) {
    const quota = new IntentQuota({ storage: new MemoryStorage() }, configuration);
    assert.equal((await reserve(quota)).status, 503);
  }
  const quota = new IntentQuota({ storage: new MemoryStorage() }, {});
  const invalid = await quota.fetch(new Request('https://quota/reserve', { method: 'POST', body: '{"clientKey":"bad"}' }));
  assert.equal(invalid.status, 400);
});

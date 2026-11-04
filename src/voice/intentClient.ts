import type { IntentRequest, IntentResponse } from '../../shared/intent';
import { INTENT_VALUES } from '../../shared/intent';

export type IntentClient = (text: string, signal: AbortSignal) => Promise<IntentResponse>;
export type IntentErrorCode = 'unconfigured' | 'timeout' | 'aborted' | 'rate-limited' | 'service' | 'invalid-response';

export class IntentClientError extends Error {
  constructor(public readonly code: IntentErrorCode) {
    super(code);
    this.name = 'IntentClientError';
  }
}

export function createIntentClient(options: {
  url?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
} = {}): IntentClient {
  return async (text, signal) => {
    if (signal.aborted) throw new IntentClientError('aborted');
    const endpoint = options.url ?? import.meta.env?.VITE_INTENT_API_URL;
    if (!endpoint) throw new IntentClientError('unconfigured');
    let url: URL;
    try { url = new URL(endpoint); }
    catch { throw new IntentClientError('unconfigured'); }
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) throw new IntentClientError('unconfigured');
    if (!text.trim() || text.length > 500) throw new IntentClientError('invalid-response');

    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; request.abort(); }, options.timeoutMs ?? 8_000);
    try {
      const body: IntentRequest = { text: text.trim() };
      const response = await (options.fetch ?? fetch)(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal,
        credentials: 'omit',
      });
      if (response.status === 429) throw new IntentClientError('rate-limited');
      if (!response.ok) throw new IntentClientError('service');
      let result: unknown;
      try { result = await response.json(); }
      catch { throw new IntentClientError('invalid-response'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || Object.keys(result).length !== 1 || !('intent' in result)
        || !INTENT_VALUES.includes(result.intent as IntentResponse['intent'])) {
        throw new IntentClientError('invalid-response');
      }
      return result as IntentResponse;
    } catch (error) {
      if (signal.aborted) throw new IntentClientError('aborted');
      if (timedOut) throw new IntentClientError('timeout');
      if (error instanceof IntentClientError) throw error;
      throw new IntentClientError('service');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  };
}

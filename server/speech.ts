import type { IntentEnvironment } from './intent.js';
import { reserveQuota } from './quota.js';
import { SPEECH_SAMPLE_RATE } from '../shared/speech.js';
import type { SpeechServerEvent } from '../shared/speech.js';

export interface SpeechEnvironment extends IntentEnvironment {
  ASR_API_URL?: string;
  ASR_MODEL?: string;
  ASR_API_KEY?: string;
}

export interface BridgeSocket extends EventTarget {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

interface WorkerSocket extends WebSocket { accept(): void }
declare const WebSocketPair: new () => { 0: WorkerSocket; 1: WorkerSocket };

export const SPEECH_HOTWORDS = {
  小满同学: 5, 左前车窗: 4, 右前车窗: 4, 左后车窗: 4, 右后车窗: 4,
  左前门: 3, 右前门: 3, 左后门: 3, 右后门: 3, 前备箱: 4, 后备箱: 4,
  打开: 2, 关闭: 2, 升起: 2, 降下: 2, 熄火: 3, 打开一点: 3, 打开一半: 3,
};

export function bridgeSpeech(
  client: BridgeSocket,
  provider: BridgeSocket,
  model: string,
  durationMs = 120000,
): void {
  const taskId = crypto.randomUUID().replaceAll('-', '');
  let closed = false;
  let ready = false;
  let bytes = 0;
  const startedAt = Date.now();
  const emit = (event: SpeechServerEvent) => { client.send(JSON.stringify(event)); };
  const finish = (error?: 'speech-service' | 'audio-limit') => {
    if (closed) return;
    closed = true;
    clearTimeout(startTimer);
    clearTimeout(sessionTimer);
    try { emit(error ? { type: 'error', code: error } : { type: 'end' }); } catch { /* The browser may have disconnected. */ }
    try { client.close(1000, 'Session ended'); } catch { /* Already closed. */ }
    try { provider.close(1000, 'Session ended'); } catch { /* Already closed. */ }
  };
  const startTimer = setTimeout(() => finish('speech-service'), 10000);
  const sessionTimer = setTimeout(() => finish(), durationMs);

  client.addEventListener('message', (event) => {
    if (closed) return;
    const data: unknown = (event as MessageEvent).data;
    if (!ready || !(data instanceof ArrayBuffer) || data.byteLength % 2 !== 0 || data.byteLength > 16000) {
      finish('audio-limit');
      return;
    }
    bytes += data.byteLength;
    const maxBytes = Math.min(durationMs, Date.now() - startedAt + 2000) * SPEECH_SAMPLE_RATE * 2 / 1000;
    if (bytes > maxBytes) { finish('audio-limit'); return; }
    try { provider.send(data); } catch { finish('speech-service'); }
  });
  client.addEventListener('close', () => finish());
  client.addEventListener('error', () => finish('speech-service'));
  provider.addEventListener('close', () => finish());
  provider.addEventListener('error', () => finish('speech-service'));
  provider.addEventListener('message', (event) => {
    if (closed) return;
    try {
      const data = (event as MessageEvent).data;
      if (typeof data !== 'string' || data.length > 65536) { finish('speech-service'); return; }
      const message = JSON.parse(data);
      if (message.header?.task_id !== taskId) return;
      switch (message.header.event) {
        case 'task-started':
          ready = true;
          clearTimeout(startTimer);
          emit({ type: 'ready' });
          break;
        case 'result-generated': {
          const sentence = message.payload?.output?.sentence;
          if (!sentence || sentence.heartbeat) return;
          if (sentence.sentence_begin && Number.isInteger(sentence.sentence_id)) emit({ type: 'speech-start', id: sentence.sentence_id });
          if (typeof sentence.text === 'string' && sentence.text.trim() && Number.isInteger(sentence.sentence_id)) {
            emit({ type: 'transcript', id: sentence.sentence_id, text: sentence.text, final: sentence.sentence_end === true });
          }
          break;
        }
        case 'task-failed': finish('speech-service'); break;
        case 'task-finished': finish(); break;
      }
    } catch { finish('speech-service'); }
  });
  try {
    provider.send(JSON.stringify({
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio', task: 'asr', function: 'recognition', model,
        parameters: {
          format: 'pcm', sample_rate: SPEECH_SAMPLE_RATE, language_hints: ['zh'],
          intermediate_result_enabled: true, max_sentence_silence: 650,
          disfluency_removal_enabled: false, heartbeat: true, vocabulary: SPEECH_HOTWORDS,
        },
        input: {},
      },
    }));
  } catch { finish('speech-service'); }
}

export async function handleSpeech(request: Request, environment: SpeechEnvironment): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const error = (status: number, code: string) => Response.json({ error: { code } }, { status, headers });
  const origin = request.headers.get('Origin');
  const allowed = (environment.ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return error(403, 'ORIGIN_NOT_ALLOWED');
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return error(426, 'WEBSOCKET_REQUIRED');
  }
  const key = environment.ASR_API_KEY || environment.MODEL_API_KEY;
  if (!key || !environment.INTENT_QUOTA) return error(503, 'SPEECH_UNAVAILABLE');
  let endpoint: URL;
  try {
    endpoint = new URL(environment.ASR_API_URL ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/');
    if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
      return error(503, 'SPEECH_UNAVAILABLE');
    }
    endpoint.protocol = 'https:';
  } catch { return error(503, 'SPEECH_UNAVAILABLE'); }
  try {
    const quota = await reserveQuota(request, environment.INTENT_QUOTA, 'speech');
    if (quota.status === 429) return error(429, 'QUOTA_EXCEEDED');
    if (quota.status !== 204) return error(503, 'SPEECH_UNAVAILABLE');
  } catch { return error(503, 'SPEECH_UNAVAILABLE'); }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10000);
  try {
    const response = await fetch(endpoint, {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${key}` },
      signal: abort.signal, redirect: 'manual',
    }) as Response & { webSocket?: WorkerSocket };
    if (response.status !== 101 || !response.webSocket) {
      console.warn('ASR handshake failed', response.status);
      void response.body?.cancel().catch(() => {});
      return error(502, 'SPEECH_UNAVAILABLE');
    }
    const sockets = new WebSocketPair();
    sockets[1].binaryType = 'arraybuffer';
    sockets[1].accept();
    response.webSocket.accept();
    bridgeSpeech(sockets[1], response.webSocket, environment.ASR_MODEL ?? 'qwen-audio-3.1-asr-flash-message');
    return new Response(null, { status: 101, webSocket: sockets[0] } as ResponseInit);
  } catch (cause) {
    console.warn('ASR connection failed', cause instanceof Error ? cause.message : 'Connection error');
    return error(502, 'SPEECH_UNAVAILABLE');
  }
  finally { clearTimeout(timer); }
}

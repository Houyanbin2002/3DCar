import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeSpeech, handleSpeech, SPEECH_HOTWORDS } from '../speech.js';
import type { SpeechEnvironment } from '../speech.js';

class Socket extends EventTarget {
  sent: (string | ArrayBuffer)[] = [];
  closed = 0;
  send(data: string | ArrayBuffer) { this.sent.push(data); }
  close() { this.closed++; }
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
  events() { return this.sent.filter((data): data is string => typeof data === 'string').map((data) => JSON.parse(data)); }
}

function connection(duration?: number) {
  const client = new Socket();
  const provider = new Socket();
  bridgeSpeech(client, provider, 'test-asr', duration);
  const start = provider.events()[0];
  const emit = (event: string, payload = {}, taskId = start.header.task_id) =>
    provider.message(JSON.stringify({ header: { event, task_id: taskId }, payload }));
  const close = () => client.dispatchEvent(new Event('close'));
  return { client, provider, start, emit, close };
}

test('ASR config pins PCM, Chinese, hotwords and finalized sentence protocol', () => {
  const c = connection();
  try {
    assert.equal(c.start.payload.model, 'test-asr');
    assert.equal(c.start.payload.parameters.sample_rate, 16000);
    assert.equal(c.start.payload.parameters.format, 'pcm');
    assert.deepEqual(c.start.payload.parameters.language_hints, ['zh']);
    assert.deepEqual(c.start.payload.parameters.vocabulary, SPEECH_HOTWORDS);
    assert.equal(c.start.payload.parameters.intermediate_result_enabled, true);
    c.emit('task-started');
    const pcm = new ArrayBuffer(3200);
    c.client.message(pcm);
    assert.equal(c.provider.sent.at(-1), pcm);
    c.emit('result-generated', { output: { sentence: { sentence_id: 1, sentence_begin: true, text: '小满', sentence_end: false } } });
    c.emit('result-generated', { output: { sentence: { sentence_id: 1, text: '小满同学，打开左前车窗。', sentence_end: true } } });
    assert.deepEqual(c.client.events(), [
      { type: 'ready' }, { type: 'speech-start', id: 1 },
      { type: 'transcript', id: 1, text: '小满', final: false },
      { type: 'transcript', id: 1, text: '小满同学，打开左前车窗。', final: true },
    ]);
  } finally { c.close(); }
});

test('heartbeat and stale task events never become user speech', () => {
  const c = connection();
  try {
    c.emit('task-started', {}, 'other-task');
    c.emit('result-generated', { output: { sentence: { heartbeat: true, text: 'noise', sentence_id: 0 } } });
    c.emit('result-generated', { output: { sentence: { text: 'bad id', sentence_id: '1' } } });
    assert.deepEqual(c.client.sent, []);
  } finally { c.close(); }
});

test('untrusted command, oversized, odd-sized and pre-ready audio close both sides', () => {
  for (const data of ['{"header":{"action":"run-task"}}', new ArrayBuffer(16002), new ArrayBuffer(3)]) {
    const c = connection();
    c.emit('task-started');
    c.client.message(data);
    assert.deepEqual(c.client.events().at(-1), { type: 'error', code: 'audio-limit' });
    assert.equal(c.client.closed, 1);
    assert.equal(c.provider.closed, 1);
  }
  const c = connection();
  c.client.message(new ArrayBuffer(3200));
  assert.equal(c.client.events().at(-1).code, 'audio-limit');
});

test('audio cannot be uploaded faster than bounded realtime allowance', () => {
  const c = connection();
  c.emit('task-started');
  for (let i = 0; i < 10; i++) c.client.message(new ArrayBuffer(16000));
  assert.equal(c.client.events().at(-1).code, 'audio-limit');
  assert.equal(c.provider.closed, 1);
});

test('provider failure is sanitized and late events cannot restart a session', () => {
  const c = connection();
  c.emit('task-failed', { secret: 'provider-internals' });
  c.emit('task-started');
  c.close();
  assert.deepEqual(c.client.events(), [{ type: 'error', code: 'speech-service' }]);
  assert.equal(c.provider.closed, 1);
});

test('connection closes at the session time limit', async () => {
  const c = connection(10);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(c.client.events(), [{ type: 'end' }]);
  assert.equal(c.provider.closed, 1);
});

const env: SpeechEnvironment = {
  ALLOWED_ORIGINS: 'https://demo.github.io', MODEL_API_KEY: 'test-secret',
  INTENT_QUOTA: { getByName: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
};
function request(origin = 'https://demo.github.io', upgrade = 'websocket') {
  return new Request('https://api.example/api/speech', { headers: { Origin: origin, Upgrade: upgrade } });
}

test('public speech route rejects unauthorized origins and non-WebSocket requests', async () => {
  assert.equal((await handleSpeech(request('https://other.example'), env)).status, 403);
  assert.equal((await handleSpeech(request('https://demo.github.io', ''), env)).status, 426);
});

test('missing secrets, unsafe provider endpoints and exhausted quota fail closed', async () => {
  assert.equal((await handleSpeech(request(), { ...env, MODEL_API_KEY: '' })).status, 503);
  assert.equal((await handleSpeech(request(), { ...env, ASR_API_URL: 'ws://unsafe.example' })).status, 503);
  const response = await handleSpeech(request(), {
    ...env, INTENT_QUOTA: { getByName: (name) => {
      assert.equal(name, 'speech');
      return { fetch: async () => new Response(null, { status: 429 }) };
    } },
  });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: { code: 'QUOTA_EXCEEDED' } });
});

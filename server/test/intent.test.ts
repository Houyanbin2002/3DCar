import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleIntent } from '../intent.js';
import type { IntentEnvironment } from '../intent.js';

const ORIGIN = 'https://demo-user.github.io';
const URL = 'https://intent.example/api/intent';

function environment(overrides: Partial<IntentEnvironment> = {}): IntentEnvironment {
  return {
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`,
    MODEL_API_URL: 'https://model.example/v1/chat/completions',
    MODEL_API_KEY: 'test-only-secret',
    MODEL_NAME: 'test-chat-model',
    INTENT_QUOTA: { getByName: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
    ...overrides,
  };
}

function request(body: BodyInit = JSON.stringify({ text: '车里有点闷热' }), options: RequestInit = {}): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body,
    ...options,
  });
}

function modelResponse(content: string, finishReason = 'stop'): Response {
  return Response.json({ choices: [{ finish_reason: finishReason, message: { content } }] });
}

const unexpectedModelCall: typeof fetch = async () => { throw new Error('Model must not be called'); };

test('passes only final text to the configured model and returns both allowed intents', async () => {
  for (const intent of ['ventilate', 'unsupported']) {
    let calls = 0;
    const response = await handleIntent(request(JSON.stringify({ text: '  想透透气  ' })), environment(), async (url, init) => {
      calls += 1;
      assert.equal(String(url), 'https://model.example/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-only-secret');
      assert.equal(init?.redirect, 'manual');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.messages[1].role, 'user');
      assert.equal(body.messages[1].content, '想透透气');
      assert.equal(body.model, 'test-chat-model');
      assert.equal(body.max_tokens, 64);
      assert.equal(body.stream, false);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      return modelResponse(JSON.stringify({ intent }));
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { intent });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(calls, 1);
  }
});

test('Qwen Omni fallback requests text JSON with thinking disabled', async () => {
  const response = await handleIntent(request(), environment({ MODEL_NAME: 'qwen3.8-omni-flash' }), async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'qwen3.8-omni-flash');
    assert.equal(body.reasoning_effort, 'none');
    assert.deepEqual(body.modalities, ['text']);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.max_tokens, 64);
    assert.equal(body.stream, false);
    return modelResponse('{"intent":"ventilate"}');
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { intent: 'ventilate' });
});

test('rejects malformed or ambiguous request objects before quota and model calls', async () => {
  let reservations = 0;
  const env = environment({ INTENT_QUOTA: { getByName: () => ({ fetch: async () => {
    reservations += 1;
    return new Response(null, { status: 204 });
  } }) } });
  for (const body of ['{', 'null', '[]', '{}', '{"text":3}', '{"text":"  "}', '{"text":"闷","key":"bad"}', JSON.stringify({ text: 'a'.repeat(1001) })]) {
    const response = await handleIntent(request(body), env, unexpectedModelCall);
    assert.equal(response.status, 400, body.slice(0, 60));
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  }
  assert.equal(reservations, 0);
});

test('counts Unicode code points and enforces actual streamed bytes', async () => {
  const valid = await handleIntent(request(JSON.stringify({ text: '闷'.repeat(1000) })), environment(), async () => modelResponse('{"intent":"ventilate"}'));
  assert.equal(valid.status, 200);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"text":"'));
      controller.enqueue(new Uint8Array(4096).fill(97));
      controller.close();
    },
  });
  const response = await handleIntent(request(stream, { duplex: 'half' } as RequestInit), environment(), unexpectedModelCall);
  assert.equal(response.status, 413);
});

test('rejects oversized advertised length and invalid UTF-8', async () => {
  const oversized = await handleIntent(request('{}', { headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': '4097' } }), environment(), unexpectedModelCall);
  assert.equal(oversized.status, 413);
  const invalid = await handleIntent(request(new Uint8Array([0xff])), environment(), unexpectedModelCall);
  assert.equal(invalid.status, 400);
});

test('cancels an input stream that never completes', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  });
  const response = await handleIntent(
    request(body, { duplex: 'half' } as RequestInit),
    environment(),
    unexpectedModelCall,
  );
  assert.equal(response.status, 408);
  assert.equal(cancelled, true);
});

test('validates paths, methods, origin and content type', async () => {
  const cases: [Request, number][] = [
    [new Request('https://intent.example/elsewhere', { headers: { Origin: ORIGIN } }), 404],
    [new Request(URL, { headers: { Origin: ORIGIN } }), 405],
    [request('{}', { headers: { 'Content-Type': 'application/json' } }), 403],
    [request('{}', { headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' } }), 403],
    [request('{}', { headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' } }), 415],
  ];
  for (const [input, status] of cases) {
    const response = await handleIntent(input, environment(), unexpectedModelCall);
    assert.equal(response.status, status);
    if (status === 403) assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    else assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  }
});

test('preflight succeeds without model credentials and rejects unknown headers', async () => {
  const preflight = (headers: string) => new Request(URL, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': headers },
  });
  const response = await handleIntent(preflight('Content-Type'), environment({ MODEL_API_KEY: undefined }), unexpectedModelCall);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  const denied = await handleIntent(preflight('Content-Type, Authorization'), environment(), unexpectedModelCall);
  assert.equal(denied.status, 403);
});

test('fails closed on missing or invalid deployment configuration', async () => {
  for (const override of [
    { MODEL_API_KEY: undefined }, { MODEL_NAME: '' }, { MODEL_API_URL: 'http://model.example/api' },
    { MODEL_API_URL: 'https://user:password@model.example/api' }, { MODEL_API_URL: 'invalid' },
    { MODEL_TIMEOUT_MS: 'invalid' }, { MODEL_TIMEOUT_MS: '30001' }, { INTENT_QUOTA: undefined },
    { ALLOWED_ORIGINS: '*' }, { ALLOWED_ORIGINS: '' },
  ]) {
    const response = await handleIntent(request(), environment(override), unexpectedModelCall);
    assert.equal(response.status, 503);
  }
});

test('exposes quota rejection and stops model invocation on storage failure', async () => {
  const rateLimited = await handleIntent(request(), environment({
    INTENT_QUOTA: {
      getByName: () => ({
        fetch: async () => new Response(null, { status: 429, headers: { 'Retry-After': '37' } }),
      }),
    },
  }), unexpectedModelCall);
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.headers.get('Retry-After'), '37');
  assert.equal(rateLimited.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
  const unavailable = await handleIntent(request(), environment({
    INTENT_QUOTA: {
      getByName: () => ({
        fetch: async () => { throw new Error('private storage error'); },
      }),
    },
  }), unexpectedModelCall);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.text()).includes('private storage'), false);
});

test('rejects malformed, extra-field, unsupported, truncated and oversized model responses', async () => {
  const invalidResponses = [
    () => modelResponse('hello'),
    () => modelResponse('{"intent":"drive"}'),
    () => modelResponse('{"intent":"ventilate","action":"open-all"}'),
    () => modelResponse('null'),
    () => modelResponse('{"intent":"ventilate"}', 'length'),
    () => Response.json({ choices: [] }),
    () => new Response('a'.repeat(65537)),
  ];
  for (const invalid of invalidResponses) {
    const response = await handleIntent(request(), environment(), async () => invalid());
    assert.equal(response.status, 502);
  }
});

test('maps upstream errors and timeouts without exposing credentials or provider bodies', async () => {
  const upstreamError = await handleIntent(request(), environment(), async () => new Response('private provider error test-only-secret', { status: 401 }));
  assert.equal(upstreamError.status, 502);
  assert.equal((await upstreamError.text()).includes('test-only-secret'), false);
  const networkError = await handleIntent(request(), environment(), async () => { throw new Error('private transport error'); });
  assert.equal(networkError.status, 502);
  const timeout = await handleIntent(request(), environment({ MODEL_TIMEOUT_MS: '10' }), async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  assert.equal(timeout.status, 504);
  assert.deepEqual(await timeout.json(), { error: { code: 'MODEL_TIMEOUT' } });
});

test('rejects provider redirects without forwarding the API key to a redirect destination', async () => {
  let calls = 0;
  const response = await handleIntent(request(), environment(), async (_url, init) => {
    calls += 1;
    assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://other.example/model' } });
  });
  assert.equal(response.status, 502);
  assert.equal(calls, 1);
  assert.deepEqual(await response.json(), { error: { code: 'MODEL_UNAVAILABLE' } });
});

test('deadline covers a stalled model response stream', async () => {
  const response = await handleIntent(request(), environment({ MODEL_TIMEOUT_MS: '10' }), async () => new Response(new ReadableStream()));
  assert.equal(response.status, 504);
});

const runtimeTool = {
  type: 'function', function: {
    name: 'set_cabin_temperature', description: '运行时新增的温度工具。',
    parameters: { type: 'object', additionalProperties: false, required: ['celsius'], properties: { celsius: { type: 'number', minimum: 16, maximum: 30 } } },
  },
};

function toolRequest() {
  return request(JSON.stringify({ text: '空调调到24度', tools: [runtimeTool], context: { temperature: 20 } }));
}

function toolResponse(name = 'set_cabin_temperature', args: unknown = { celsius: 24 }) {
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
    content: null, tool_calls: [{ id: 'temperature-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } }] });
}

test('injects runtime tools into Qwen and returns validated function calls', async () => {
  const response = await handleIntent(toolRequest(), environment({ MODEL_NAME: 'qwen3.8-omni-flash' }), async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.tools, [runtimeTool]);
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.max_tokens, 512);
    assert.equal(body.response_format, undefined);
    assert.deepEqual(JSON.parse(body.messages[1].content), { text: '空调调到24度', context: { temperature: 20 } });
    return toolResponse();
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { toolCalls: [{ id: 'temperature-call', name: 'set_cabin_temperature', arguments: { celsius: 24 } }], reply: '' });
});

test('ambiguous or unsupported expressions may return clarification with no tool calls', async () => {
  const response = await handleIntent(toolRequest(), environment(), async () => modelResponse('你想设置多少度？'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { toolCalls: [], reply: '你想设置多少度？' });
});

test('rejects unknown tool names, extra arguments and values outside runtime schema', async () => {
  for (const upstream of [
    toolResponse('unregistered'), toolResponse('set_cabin_temperature', { celsius: 99 }),
    toolResponse('set_cabin_temperature', { celsius: '24' }), toolResponse('set_cabin_temperature', { celsius: 24, extra: true }),
  ]) {
    const response = await handleIntent(toolRequest(), environment(), async () => upstream);
    assert.equal(response.status, 502);
  }
});

test('rejects invalid runtime schemas before requesting the model', async () => {
  for (const tools of [[], [runtimeTool, runtimeTool], [{ ...runtimeTool, function: { ...runtimeTool.function, name: 'invalid tool name' } }]]) {
    const response = await handleIntent(request(JSON.stringify({ text: '调空调', tools, context: {} })), environment(), unexpectedModelCall);
    assert.equal(response.status, 400);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceControl } from '../VoiceControl';
import type { VoiceClock } from '../VoiceControl';
import { createIntentClient, IntentClientError } from '../intentClient';
import type { IntentClient } from '../intentClient';
import { extractWakeCommand, parseCommand } from '../parseCommand';
import { createBrowserSpeechInput } from '../speechIO';
import type { NativeRecognition, SpeechInput, SpeechInputEvents, SpeechOutput } from '../speechIO';
import { createSimulatedVehicle } from '../../../dev/voice/mockVehicle';
import type { VehicleAction } from '../../contracts/vehicle';
import type { ControlClient } from '../controlClient';
import { createControlClient } from '../controlClient';
import { createVehicleToolRegistry, ToolExecutionError } from '../toolRegistry';
import { routeCommand } from '../parseCommand';
import type { ControlResponse, ToolCall } from '../../../shared/control';

class FakeClock implements VoiceClock {
  now = 0;
  next = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  schedule(callback: () => void, milliseconds: number) {
    const id = ++this.next;
    this.tasks.set(id, { at: this.now + milliseconds, callback });
    return () => { this.tasks.delete(id); };
  }
  advance(milliseconds: number) {
    const end = this.now + milliseconds;
    for (let count = 0; count < 1_000; count++) {
      const next = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) { this.now = end; return; }
      this.now = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    throw new Error('Timer loop exceeded the test limit');
  }
}

class FakeInput implements SpeechInput {
  supported = true;
  starts = 0;
  events: SpeechInputEvents | null = null;
  start(events: SpeechInputEvents) { this.events = events; this.starts++; events.onStart(); }
  stop() { this.events = null; }
  say(text: string, interim = '') { this.events?.onTranscript({ finals: text ? [text] : [], interim }); }
  speechStart() { this.events?.onSpeechStart(); }
  speechEnd() { this.events?.onSpeechEnd(); }
  end() { const events = this.events; this.events = null; events?.onEnd(); }
  error(code: string) { this.events?.onError(code); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(overrides: { intent?: IntentClient; output?: SpeechOutput; control?: ControlClient } = {}) {
  const clock = new FakeClock();
  const input = new FakeInput();
  const vehicle = createSimulatedVehicle();
  const calls: VehicleAction[][] = [];
  const intents: string[] = [];
  const spoken: string[] = [];
  const originalExecute = vehicle.execute;
  vehicle.execute = (actions, options) => { calls.push([...actions]); return originalExecute(actions, options); };
  const intent: IntentClient = overrides.intent ?? (async (text) => { intents.push(text); return { intent: 'ventilate' }; });
  const output: SpeechOutput = overrides.output ?? { speak: async (text) => { spoken.push(text); } };
  const controlClient: ControlClient = async (request, signal) => {
    if (request.history) return { toolCalls: [], reply: '已核对本轮执行结果。' };
    const result = await intent(request.text, signal);
    const parsed = parseCommand(request.text);
    if (parsed.kind === 'clarify') return { toolCalls: [], reply: parsed.message };
    if (result.intent === 'unsupported') return { toolCalls: [], reply: '没能理解这句话，可以说打开左前窗。' };
    const snapshot = vehicle.getSnapshot();
    const partId = (['frontLeftWindow', 'frontRightWindow', 'rearLeftWindow', 'rearRightWindow'] as const)
      .find((id) => !snapshot.parts[id].open && !snapshot.parts[id].moving);
    return partId
      ? { toolCalls: [{ id: 'test-call', name: 'set_vehicle_part', arguments: { partId, open: true } }], reply: '' }
      : { toolCalls: [], reply: '车窗已经降下了。' };
  };
  const tools = createVehicleToolRegistry(vehicle);
  const control = new VoiceControl({ controller: vehicle, clock, input, output, controlClient: overrides.control ?? controlClient, tools });
  control.start();
  return { control, clock, input, vehicle, calls, intents, spoken, tools };
}

test('明确目标、同义表达与全车动作映射到公共契约', () => {
  const cases: [string, VehicleAction][] = [
    ['打开左前门', { kind: 'part', partId: 'frontLeftDoor', open: true }],
    ['关闭右前车门', { kind: 'part', partId: 'frontRightDoor', open: false }],
    ['打开左后车门', { kind: 'part', partId: 'rearLeftDoor', open: true }],
    ['关上右后门', { kind: 'part', partId: 'rearRightDoor', open: false }],
    ['降下左前车窗', { kind: 'part', partId: 'frontLeftWindow', open: true }],
    ['升起右前窗', { kind: 'part', partId: 'frontRightWindow', open: false }],
    ['摇下左后车窗', { kind: 'part', partId: 'rearLeftWindow', open: true }],
    ['关闭右后车窗', { kind: 'part', partId: 'rearRightWindow', open: false }],
    ['请帮我打开前备箱吧', { kind: 'part', partId: 'frunk', open: true }],
    ['关闭尾箱', { kind: 'part', partId: 'trunk', open: false }],
    ['打开所有车门', { kind: 'group', group: 'doors', open: true }],
    ['关闭全部车窗', { kind: 'group', group: 'windows', open: false }],
    ['启动引擎', { kind: 'engine', running: true }],
    ['熄火', { kind: 'engine', running: false }],
  ];
  for (const [text, action] of cases) {
    assert.deepEqual(parseCommand(text), { kind: 'commands', actions: [action], messages: [] }, text);
  }
});

test('多指令保持顺序、共享动作，并支持无标点完整指令', () => {
  assert.deepEqual(parseCommand('打开前备箱和后备箱'), {
    kind: 'commands', actions: [
      { kind: 'part', partId: 'frunk', open: true }, { kind: 'part', partId: 'trunk', open: true },
    ], messages: [],
  });
  assert.deepEqual(parseCommand('关闭所有车窗熄火'), {
    kind: 'commands', actions: [{ kind: 'group', group: 'windows', open: false }, { kind: 'engine', running: false }], messages: [],
  });
});

test('部分有效只产生可靠动作，模糊对象走本地提示', () => {
  const partial = parseCommand('打开左前门，再打开');
  assert.equal(partial.kind, 'commands');
  if (partial.kind !== 'commands') return;
  assert.equal(partial.actions.length, 1);
  assert.equal(partial.messages.length, 1);
  for (const text of ['打开', '车门', '开车窗', '打开车窗', '升起前备箱', '打开左前门不明后缀']) {
    assert.equal(parseCommand(text).kind, 'clarify', text);
  }
});

test('取消与否定阻止误提取动作，间接表达才进入模型', () => {
  for (const text of ['不要打开左前门', '取消', '车里闷热但不想开窗']) assert.equal(parseCommand(text).kind, 'cancelled');
  assert.equal(parseCommand('车里有点闷热').kind, 'indirect');
  assert.equal(parseCommand('车里特别闷热').kind, 'indirect');
  assert.equal(parseCommand('车里有点闷热，想透透气').kind, 'indirect');
  assert.equal(parseCommand('想透透气').kind, 'indirect');
  assert.equal(parseCommand('嗯').kind, 'clarify');
  assert.equal(extractWakeCommand('小满，小满，打开左前窗'), '，打开左前窗');
});

test('未唤醒时不调用车辆或模型，中间结果不执行', () => {
  const s = setup();
  s.input.say('打开左前门');
  s.input.say('车里有点闷热');
  s.input.say('', '小满小满打开左前门');
  s.clock.advance(2_000);
  assert.equal(s.calls.length, 0);
  assert.equal(s.intents.length, 0);
  assert.equal(s.control.getSnapshot().phase, 'waiting');
  s.control.stop();
});

test('同段唤醒与动作一次提交，第二轮必须重新唤醒', async () => {
  const s = setup();
  s.input.say('小满小满，打开左前门');
  s.clock.advance(1_000);
  await flush();
  assert.equal(s.calls.length, 1);
  assert.equal(s.vehicle.getSnapshot().parts.frontLeftDoor.open, true);
  s.input.say('关闭左前门');
  s.clock.advance(2_000);
  assert.equal(s.calls.length, 1);
  s.input.say('小满小满关闭左前门');
  s.clock.advance(1_000);
  await flush();
  assert.equal(s.calls.length, 2);
  assert.equal(s.vehicle.getSnapshot().parts.frontLeftDoor.open, false);
  s.control.stop();
});

test('5 秒未开始说指令时超时，开始说话后可继续完成', async () => {
  const s = setup();
  s.input.say('小满小满');
  s.clock.advance(5_000);
  assert.match(s.control.getSnapshot().message, /超时/u);
  s.input.say('小满小满');
  s.clock.advance(4_500);
  s.input.speechStart();
  s.input.say('', '打开左');
  s.clock.advance(1_500);
  assert.equal(s.control.getSnapshot().phase, 'listening');
  s.input.say('打开左前窗');
  s.input.speechEnd();
  s.clock.advance(1_000);
  await flush();
  assert.equal(s.calls.length, 1);
  s.control.stop();
});

test('一轮多段结果聚合，正在说话时等待后续分句', async () => {
  const s = setup();
  s.input.say('小满小满，打开前备箱');
  s.clock.advance(500);
  s.input.speechStart();
  s.clock.advance(1_000);
  assert.equal(s.calls.length, 0);
  s.input.say('和后备箱');
  s.input.speechEnd();
  s.clock.advance(1_000);
  await flush();
  assert.equal(s.calls[0].length, 2);
  assert.equal(s.control.getSnapshot().feedback.length, 2);
  s.control.stop();
});

test('部分有效先执行规则动作，模糊片段交给模型追问', async () => {
  const s = setup();
  s.input.say('小满小满打开左前门再打开');
  s.clock.advance(1_000);
  await flush();
  assert.equal(s.calls[0].length, 1);
  assert.match(s.control.getSnapshot().message, /哪个部件/u);
  s.input.say('小满小满开车窗');
  s.clock.advance(1_000);
  await flush();
  assert.match(s.control.getSnapshot().message, /哪扇/u);
  assert.equal(s.intents.length, 2);
  s.control.stop();
});

test('单轮收集上限避免卡在聆听状态', () => {
  const s = setup();
  s.input.say('小满小满');
  s.input.speechStart();
  s.clock.advance(20_000);
  assert.equal(s.control.getSnapshot().phase, 'waiting');
  assert.equal(s.calls.length, 0);
  s.control.stop();
});

test('自然结束后恢复识别，旧会话回调失效', async () => {
  const s = setup();
  const old = s.input.events!;
  s.input.end();
  old.onTranscript({ finals: ['小满小满打开右前门'], interim: '' });
  s.clock.advance(300);
  assert.equal(s.input.starts, 2);
  old.onTranscript({ finals: ['小满小满打开左前门'], interim: '' });
  s.clock.advance(1_000);
  await flush();
  assert.equal(s.calls.length, 0);
  s.control.stop();
});

test('不支持识别时 stop 和 React StrictMode 清理保持不可用提示', () => {
  const input = new FakeInput();
  input.supported = false;
  const control = new VoiceControl({ controller: createSimulatedVehicle(), input });
  control.stop();
  control.start();
  assert.equal(control.getSnapshot().phase, 'unsupported');
  assert.equal(control.getSnapshot().enabled, false);
  assert.equal(input.starts, 0);
});

test('权限与网络异常停止恢复，用户可以重试', () => {
  for (const code of ['not-allowed', 'network', 'audio-capture']) {
    const s = setup();
    s.input.error(code);
    s.clock.advance(10_000);
    assert.equal(s.control.getSnapshot().phase, 'error');
    assert.equal(s.control.getSnapshot().enabled, false);
    assert.equal(s.input.starts, 1);
    s.control.start();
    assert.equal(s.control.getSnapshot().phase, 'waiting');
    s.control.stop();
  }
});

test('模型只提出建议，确认一次后才降指定窗口', async () => {
  const s = setup();
  s.input.say('小满小满，车里有点闷热');
  s.clock.advance(1_000);
  await flush();
  assert.equal(s.intents.length, 1);
  assert.equal(s.control.getSnapshot().phase, 'confirming');
  assert.equal(s.calls.length, 0);
  assert.match(s.spoken[0], /左前窗/u);
  s.input.say('需要');
  s.control.confirm(true);
  await flush();
  assert.deepEqual(s.calls, [[{ kind: 'part', partId: 'frontLeftWindow', open: true }]]);
  s.input.say('需要');
  s.clock.advance(1_000);
  assert.equal(s.calls.length, 1);
  s.control.stop();
});

test('否定和超时清除待确认动作', async () => {
  for (const mode of ['negative', 'timeout']) {
    const s = setup();
    s.input.say('小满小满想透透气');
    s.clock.advance(1_000);
    await flush();
    if (mode === 'negative') s.input.say('不用');
    else s.clock.advance(5_000);
    s.control.confirm(true);
    await flush();
    assert.equal(s.calls.length, 0);
    assert.equal(s.control.getSnapshot().phase, 'waiting');
    s.control.stop();
  }
});

test('播报时暂停识别，播报结束后才计确认时间', async () => {
  const audio = deferred<void>();
  const s = setup({ output: { speak: () => audio.promise } });
  s.input.say('小满小满车里闷热');
  s.clock.advance(1_000);
  await flush();
  assert.equal(s.control.getSnapshot().phase, 'speaking');
  assert.equal(s.input.events, null);
  s.clock.advance(6_000);
  audio.resolve();
  await flush();
  assert.equal(s.control.getSnapshot().phase, 'confirming');
  s.clock.advance(4_999);
  assert.equal(s.control.getSnapshot().phase, 'confirming');
  s.clock.advance(1);
  assert.equal(s.control.getSnapshot().phase, 'waiting');
  s.control.stop();
});

test('关闭语音或重新唤醒使迟到的模型响应失效', async () => {
  for (const mode of ['stop', 'wake']) {
    const model = deferred<{ intent: 'ventilate' }>();
    const s = setup({ intent: () => model.promise });
    s.input.say('小满小满车里闷热');
    s.clock.advance(1_000);
    if (mode === 'stop') s.control.stop();
    else s.input.say('小满小满');
    model.resolve({ intent: 'ventilate' });
    await flush();
    assert.equal(s.control.getSnapshot().phase, mode === 'stop' ? 'off' : 'listening');
    assert.equal(s.spoken.length, 0);
    assert.equal(s.calls.length, 0);
    s.control.stop();
  }
});

test('接口失败仍可在下一轮执行明确指令', async () => {
  const s = setup({ intent: async () => { throw new Error('offline'); } });
  s.input.say('小满小满车里闷热');
  s.clock.advance(1_000);
  await flush();
  assert.match(s.control.getSnapshot().message, /暂时不可用/u);
  s.input.say('小满小满打开左前窗');
  s.clock.advance(1_000);
  await flush();
  assert.equal(s.calls.length, 1);
  s.control.stop();
});

test('按当前状态选择车窗，四窗已降下时只反馈', async () => {
  const s = setup();
  await s.vehicle.execute([{ kind: 'part', partId: 'frontLeftWindow', open: true }]);
  s.calls.length = 0;
  s.input.say('小满小满车里闷热');
  s.clock.advance(1_000);
  await flush();
  assert.match(s.spoken[0], /右前窗/u);
  s.control.confirm(false);
  await s.vehicle.execute([{ kind: 'group', group: 'windows', open: true }]);
  s.calls.length = 0;
  s.input.say('小满小满车里闷热');
  s.clock.advance(1_000);
  await flush();
  assert.match(s.control.getSnapshot().message, /已经降下/u);
  assert.equal(s.calls.length, 0);
  s.control.stop();
});

test('停止会取消未下发动作，已结束轮次的执行结果不覆盖 UI', async () => {
  const pending = deferred<[]>();
  const s = setup();
  let signal: AbortSignal | undefined;
  s.vehicle.execute = (_actions, options) => { signal = options?.signal; return pending.promise; };
  s.input.say('小满小满打开左前门再打开后备箱');
  s.clock.advance(1_000);
  s.control.stop();
  assert.equal(signal?.aborted, true);
  pending.resolve([]);
  await flush();
  assert.equal(s.control.getSnapshot().phase, 'off');
});

test('unsupported 意图与车辆未就绪都只反馈', async () => {
  const s = setup({ intent: async () => ({ intent: 'unsupported' }) });
  s.input.say('小满小满把车弄好看一点');
  s.clock.advance(1_000);
  await flush();
  assert.match(s.control.getSnapshot().message, /没能理解/u);
  const previous = s.vehicle.getSnapshot();
  s.vehicle.getSnapshot = () => ({ ...previous, ready: false });
  s.input.say('小满小满打开左前门');
  s.clock.advance(1_000);
  await flush();
  assert.match(s.control.getSnapshot().message, /加载/u);
  assert.equal(s.calls.length, 0);
  s.control.stop();
});

test('识别适配器按结果索引去重，旧 native 回调也失效', () => {
  let native!: NativeRecognition;
  class Recognition implements NativeRecognition {
    lang = ''; continuous = false; interimResults = false;
    onstart = null; onend = null; onspeechstart = null; onspeechend = null; onerror = null;
    onresult: NativeRecognition['onresult'] = null;
    constructor() { native = this; }
    start() {} abort() {}
  }
  const input = createBrowserSpeechInput(Recognition);
  const delivered: string[] = [];
  input.start({
    onStart() {}, onEnd() {}, onSpeechStart() {}, onSpeechEnd() {}, onError() {},
    onTranscript: (update) => delivered.push(...update.finals),
  });
  const results = [{ isFinal: true, 0: { transcript: '小满小满' } }];
  const old = native.onresult!;
  old({ resultIndex: 0, results });
  old({ resultIndex: 0, results });
  results.push({ isFinal: true, 0: { transcript: '打开左前门' } });
  old({ resultIndex: 1, results });
  assert.deepEqual(delivered, ['小满小满', '打开左前门']);
  input.stop();
  results.push({ isFinal: true, 0: { transcript: '关闭所有车窗' } });
  old({ resultIndex: 2, results });
  assert.equal(delivered.length, 2);
});

test('模型客户端发送契约文本并严格校验响应', async () => {
  const client = createIntentClient({ url: 'https://example.com/api/intent', fetch: async (_url, init) => {
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'omit');
    assert.deepEqual(JSON.parse(String(init?.body)), { text: '车里闷热' });
    return Response.json({ intent: 'ventilate' });
  } });
  assert.deepEqual(await client('车里闷热', new AbortController().signal), { intent: 'ventilate' });
  for (const result of [{ intent: 'open-door' }, { intent: 'ventilate', action: 'open' }, [], null]) {
    const invalid = createIntentClient({ url: 'https://example.com/api/intent', fetch: async () => Response.json(result) });
    await assert.rejects(invalid('闷热了', new AbortController().signal), { code: 'invalid-response' });
  }
});

test('模型客户端处理缺配置、限流、服务错误和无效 JSON', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(createIntentClient()('闷热了', signal), { code: 'unconfigured' });
  await assert.rejects(createIntentClient({ url: 'http://example.com/api/intent' })('闷热了', signal), { code: 'unconfigured' });
  for (const [status, code] of [[429, 'rate-limited'], [503, 'service']] as const) {
    const client = createIntentClient({ url: 'https://example.com/api/intent', fetch: async () => new Response('', { status }) });
    await assert.rejects(client('闷热了', signal), { code });
  }
  const invalid = createIntentClient({ url: 'https://example.com/api/intent', fetch: async () => new Response('not json') });
  await assert.rejects(invalid('闷热了', signal), { code: 'invalid-response' });
});

test('模型客户端处理调用前取消、调用中取消与超时', async () => {
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(createIntentClient()('闷热了', aborted.signal), { code: 'aborted' });
  const fetchUntilAbort: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const client = createIntentClient({ url: 'https://example.com/api/intent', fetch: fetchUntilAbort, timeoutMs: 5 });
  await assert.rejects(client('闷热了', new AbortController().signal), { code: 'timeout' });
  const request = new AbortController();
  const promise = client('闷热了', request.signal);
  request.abort();
  await assert.rejects(promise, (error) => error instanceof IntentClientError && error.code === 'aborted');
});

test('规则置信级别由完整匹配判定，低置信度与未匹配送模型', () => {
  const route = routeCommand('打开左前门，再把右边前面的玻璃放下来，然后熄火');
  assert.deepEqual(route.steps.map((step) => [step.source, step.confidence]), [
    ['rule', 'high'], ['model', 'unmatched'], ['rule', 'high'],
  ]);
  assert.equal(routeCommand('打开车窗').steps[0].confidence, 'low');
  assert.equal(routeCommand('不要打开左前门').cancelled, true);
});

test('运行时注册温控工具后，下次请求自动包含定义并能执行', async () => {
  let temperature = 20;
  const s = setup({ control: async (request) => {
    if (request.history) return { toolCalls: [], reply: '温度设置已完成。' };
    assert.ok(request.tools.some((tool) => tool.function.name === 'set_cabin_temperature'));
    assert.deepEqual(request.context.set_cabin_temperature, { celsius: 20 });
    return { toolCalls: [{ id: 'temperature-call', name: 'set_cabin_temperature', arguments: { celsius: 24 } }], reply: '' };
  } });
  s.tools.register({
    definition: { type: 'function', function: {
      name: 'set_cabin_temperature', description: '设置车内空调温度。',
      parameters: { type: 'object', additionalProperties: false, required: ['celsius'], properties: { celsius: { type: 'number', minimum: 16, maximum: 30 } } },
    } },
    confirmation: 'always', context: () => ({ celsius: temperature }),
    prepare: (args) => ({ label: `将空调调到${args.celsius}度`, execute: async () => { temperature = args.celsius as number; return '温度设置完成。'; } }),
  });
  s.input.say('小满小满，空调调到二十四度');
  s.clock.advance(1_000);
  await flush();
  assert.equal(temperature, 20);
  assert.match(s.spoken[0], /24/u);
  s.control.confirm(true);
  await flush();
  assert.equal(temperature, 24);
  assert.match(s.control.getSnapshot().message, /温度设置完成/u);
  s.control.stop();
});

test('模型指定的任意已注册部件按顺序执行，无通风标签映射', async () => {
  const s = setup({ control: async (request): Promise<ControlResponse> => request.history ? { toolCalls: [], reply: '本轮动作已完成。' } : ({ toolCalls: [
    { id: 'first', name: 'set_vehicle_part', arguments: { partId: 'frunk', open: true } },
    { id: 'second', name: 'set_engine_state', arguments: { running: true } },
  ], reply: '' }) });
  s.input.say('小满小满，请把前面的储物空间掀开并让车准备好');
  s.clock.advance(1_000);
  await flush();
  assert.equal(s.calls.length, 0);
  s.control.confirm(true);
  await flush();
  assert.deepEqual(s.calls.flat(), [{ kind: 'part', partId: 'frunk', open: true }, { kind: 'engine', running: true }]);
  s.control.stop();
});

test('未知工具或非法参数拒绝整批执行', () => {
  const registry = createVehicleToolRegistry(createSimulatedVehicle());
  const invalidCalls: ToolCall[] = [
    { id: 'x', name: 'unregistered', arguments: {} },
    { id: 'x', name: 'set_vehicle_part', arguments: { partId: 'frontLeftWindow', open: 'yes' } },
    { id: 'x', name: 'set_engine_state', arguments: { running: true, arbitrary: 'extra' } },
  ];
  for (const call of invalidCalls) {
    assert.throws(() => registry.prepare({ toolCalls: [call], reply: '' }));
  }
});

test('工具卸载后旧批次失效，新注册实例不能恢复旧批次', async () => {
  const registry = createVehicleToolRegistry(createSimulatedVehicle());
  let executed = false;
  const tool = {
    definition: { type: 'function' as const, function: {
      name: 'set_light', description: '控制灯光。',
      parameters: { type: 'object' as const, additionalProperties: false as const, required: ['on'], properties: { on: { type: 'boolean' as const } } },
    } },
    confirmation: 'always' as const,
    prepare: () => ({ label: '打开灯光', execute: async () => { executed = true; return '灯光已打开。'; } }),
  };
  const unregister = registry.register(tool);
  const batch = registry.prepare({ toolCalls: [{ id: 'light', name: 'set_light', arguments: { on: true } }], reply: '' });
  unregister();
  registry.register(tool);
  const results = await registry.execute(batch, new AbortController().signal, () => {});
  assert.equal(results[0].status, 'not_run');
  assert.equal(executed, false);
});

test('控制客户端发送运行时定义并拒绝未提供工具的响应', async () => {
  const registry = createVehicleToolRegistry(createSimulatedVehicle());
  const request = { text: '想透透气', tools: registry.definitions(), context: registry.context() };
  const client = createControlClient({ url: 'https://example.com/api/intent', fetch: async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).tools, request.tools);
    return Response.json({ toolCalls: [{ id: 'open-window', name: 'set_vehicle_part', arguments: { partId: 'frontLeftWindow', open: true } }], reply: '' });
  } });
  const result = await client(request, new AbortController().signal);
  assert.equal(result.toolCalls[0].name, 'set_vehicle_part');
  const invalid = createControlClient({ url: 'https://example.com/api/intent', fetch: async () => Response.json({ toolCalls: [{ id: 'x', name: 'shell', arguments: { command: 'anything' } }], reply: '' }) });
  await assert.rejects(invalid(request, new AbortController().signal), { code: 'invalid-response' });
});

test('只读工具按登记策略直接执行，车辆动作仍由确认策略控制', async () => {
  const s = setup({ control: async (request) => request.history ? { toolCalls: [], reply: '状态读取已完成。' }
    : { toolCalls: [{ id: 'read-state', name: 'read_status', arguments: {} }], reply: '' } });
  let readCount = 0;
  s.tools.register({
    definition: { type: 'function', function: {
      name: 'read_status', description: '读取当前展厅状态。',
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    } },
    confirmation: 'never',
    prepare: () => ({ label: '读取状态', execute: async () => { readCount++; return '状态读取完成。'; } }),
  });
  s.input.say('小满小满现在的状态怎么样');
  s.clock.advance(1_000);
  await flush();
  assert.equal(readCount, 1);
  assert.equal(s.control.getSnapshot().phase, 'waiting');
  assert.equal(s.spoken.length, 0);
  s.control.stop();
});

test('语音确认一次后完成三项调用和失败项重试，最终恢复等待唤醒', async () => {
  const names = ['demo_first', 'demo_second', 'demo_third'];
  const attempts = [0, 0, 0];
  const s = setup({ control: async (request) => {
    if (!request.history) return { toolCalls: names.map((name, index) => ({ id: `initial-${index}`, name, arguments: { open: true } })), reply: '' };
    if (request.history.length === 1) {
      assert.deepEqual(request.history[0].results.map((result) => result.status), ['succeeded', 'failed', 'succeeded']);
      return { toolCalls: [{ id: 'retry-second', name: names[1], arguments: { open: true } }], reply: '' };
    }
    return { toolCalls: [], reply: '三个测试模块均已完成。' };
  } });
  for (const [index, name] of names.entries()) {
    s.tools.register({
      definition: { type: 'function', function: { name, description: '独立测试模块', parameters: { type: 'object', additionalProperties: false, required: ['open'], properties: { open: { type: 'boolean' } } } } },
      confirmation: 'always',
      prepare: () => ({ label: `开启测试模块${index + 1}`, execute: async () => {
        attempts[index]++;
        if (index === 1 && attempts[index] === 1) throw new ToolExecutionError('暂时忙。', { code: 'PART_BUSY', retryable: true, effect: 'not_applied' });
        return `测试模块${index + 1}已开启。`;
      } }),
    });
  }
  s.input.say('小满小满，请启动三个测试模块');
  s.clock.advance(1_000);
  await flush();
  assert.deepEqual(attempts, [0, 0, 0]);
  assert.equal(s.control.getSnapshot().phase, 'confirming');
  s.control.confirm(true);
  await flush();
  assert.deepEqual(attempts, [1, 2, 1]);
  assert.equal(s.spoken.length, 1);
  assert.equal(s.control.getSnapshot().phase, 'waiting');
  assert.ok(s.control.getSnapshot().feedback.some((message) => message.includes('最终完成3项，失败0项')));
  s.control.stop();
});

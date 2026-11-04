import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ControlClient } from '../controlClient';
import { ToolExecutionError, ToolRegistry } from '../toolRegistry';
import { runToolCycle } from '../runToolCycle';
import type { ControlResponse, ToolCall, ToolExchange } from '../../../shared/control';
import { validToolHistory } from '../../../shared/control';

const call = (id: string, name: string, value = 1): ToolCall => ({ id, name, arguments: { value } });

function fixture(failure: 'transient' | 'permanent' | 'always' = 'transient') {
  const registry = new ToolRegistry();
  const attempts = [0, 0, 0];
  const state = [0, 0, 0];
  for (const [index, name] of ['first', 'second', 'third'].entries()) {
    registry.register({
      definition: { type: 'function', function: {
        name, description: `独立动作 ${name}`,
        parameters: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'number', minimum: 0, maximum: 10 } } },
      } },
      confirmation: 'always',
      context: () => ({ value: state[index] }),
      prepare: (args) => ({ label: name, execute: async () => {
        attempts[index]++;
        if (index === 1 && (failure !== 'transient' || attempts[index] === 1)) {
          if (failure === 'permanent') throw new Error('Unclassified failure');
          throw new ToolExecutionError('部件暂时忙。', { code: 'PART_BUSY', retryable: true, effect: 'not_applied' });
        }
        state[index] = args.value as number;
        return `${name}已完成。`;
      } }),
    });
  }
  const initial: ControlResponse = { toolCalls: [call('a', 'first'), call('b', 'second'), call('c', 'third')], reply: '' };
  const batch = registry.prepare(initial);
  const request = { text: '完成三个动作', tools: registry.definitions(), context: registry.context() };
  const messages: string[] = [];
  const run = (client: ControlClient, signal = new AbortController().signal) => runToolCycle({
    plan: { batch, request }, registry, client, signal, onMessage: (message) => messages.push(message), onPhase() {},
  });
  return { registry, attempts, state, run, messages, batch };
}

test('三项中第二项失败，其他两项完成，仅重试失败项并将全部结果回传模型', async () => {
  const f = fixture();
  const observations: ToolExchange[][] = [];
  const result = await f.run(async (request) => {
    assert.ok(request.history);
    assert.equal(validToolHistory(request.history, request.tools), true);
    observations.push(structuredClone(request.history));
    if (request.history.length === 1) {
      assert.deepEqual(request.history[0].results.map((item) => item.status), ['succeeded', 'failed', 'succeeded']);
      assert.deepEqual(request.history[0].results[1].error, { code: 'PART_BUSY', retryable: true });
      assert.deepEqual(request.history[0].results[1].actualState, { value: 0 });
      return { toolCalls: [call('retry-b', 'second')], reply: '' };
    }
    assert.equal(request.history[1].results[0].status, 'succeeded');
    return { toolCalls: [], reply: '三个动作均已完成，第二项经重试成功。' };
  });
  assert.deepEqual(f.attempts, [1, 2, 1]);
  assert.deepEqual(f.state, [1, 1, 1]);
  assert.equal(observations.length, 2);
  assert.match(result.summary, /完成3项，失败0项/u);
});

test('不可恢复异常保留两项成功，模型获得不允许重试的失败结果', async () => {
  const f = fixture('permanent');
  const result = await f.run(async (request) => {
    const report = request.history![0].results[1];
    assert.equal(report.effect, 'unknown');
    assert.equal(report.error?.retryable, false);
    return { toolCalls: [], reply: '第一项和第三项完成，第二项失败。' };
  });
  assert.deepEqual(f.attempts, [1, 1, 1]);
  assert.match(result.summary, /完成2项，失败1项/u);
});

test('模型重复成功动作或改变失败参数，执行器均拦截整份重试计划', async () => {
  for (const retry of [call('replay', 'first'), call('changed', 'second', 2), call('b', 'second')]) {
    const f = fixture();
    await f.run(async () => ({ toolCalls: [retry], reply: '' }));
    assert.deepEqual(f.attempts, [1, 1, 1]);
    assert.ok(f.messages.some((message) => message.includes('拦截')));
  }
});

test('重试再次失败后额度为零，第三次调用请求被拦截', async () => {
  const f = fixture('always');
  const result = await f.run(async (request) => {
    if (request.history!.length === 1) return { toolCalls: [call('retry-b', 'second')], reply: '' };
    assert.equal(request.history![1].results[0].error?.retryable, false);
    return { toolCalls: [call('retry-again', 'second')], reply: '' };
  });
  assert.deepEqual(f.attempts, [1, 2, 1]);
  assert.match(result.summary, /失败1项/u);
});

test('结果反馈接口不可用时保留已完成动作与准确的部分成功汇总', async () => {
  const f = fixture();
  const result = await f.run(async () => { throw new Error('Model offline'); });
  assert.deepEqual(f.attempts, [1, 1, 1]);
  assert.match(result.summary, /完成2项，失败1项/u);
  assert.ok(f.messages.some((message) => message.includes('复核暂时不可用')));
});

test('等待模型重试决策时取消，迟到的重试计划不执行', async () => {
  const f = fixture();
  const abort = new AbortController();
  const promise = f.run(async () => {
    abort.abort();
    return { toolCalls: [call('retry-b', 'second')], reply: '' };
  }, abort.signal);
  await assert.rejects(promise, { name: 'AbortError' });
  assert.deepEqual(f.attempts, [1, 1, 1]);
});

test('结果不确定时只允许有状态观察的幂等工具标记可重试', async () => {
  for (const mode of ['non-idempotent', 'no-state', 'observed-idempotent']) {
    const registry = new ToolRegistry();
    registry.register({
      definition: { type: 'function', function: { name: 'uncertain', description: '不确定结果测试', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } },
      confirmation: 'always', idempotent: mode !== 'non-idempotent',
      context: mode === 'no-state' ? undefined : () => ({ open: false }),
      prepare: () => ({ label: '设置部件', execute: async () => { throw new ToolExecutionError('完成状态不确定。', { code: 'ACTION_TIMEOUT', retryable: true, effect: 'unknown' }); } }),
    });
    const batch = registry.prepare({ toolCalls: [{ id: 'uncertain-call', name: 'uncertain', arguments: {} }], reply: '' });
    const [result] = await registry.execute(batch, new AbortController().signal, () => {});
    assert.equal(result.error?.retryable, mode === 'observed-idempotent');
  }
});

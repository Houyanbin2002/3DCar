import type { ControlRequest, ToolExchange, ToolExecutionResult } from '../../shared/control';
import { operationKey, retryableCalls, validRetryResponse } from '../../shared/control';
import type { ControlClient } from './controlClient';
import type { PreparedToolBatch, ToolRegistry } from './toolRegistry';

export interface ToolExecutionPlan {
  batch: PreparedToolBatch;
  request: ControlRequest;
}

export interface ToolCycleResult {
  history: ToolExchange[];
  summary: string;
}

export async function runToolCycle(options: {
  plan: ToolExecutionPlan;
  registry: ToolRegistry;
  client: ControlClient;
  signal: AbortSignal;
  onMessage(message: string): void;
  onPhase(phase: 'thinking' | 'executing', message: string): void;
}): Promise<ToolCycleResult> {
  const { plan, registry, client, signal, onMessage, onPhase } = options;
  const history: ToolExchange[] = [];
  let batch = plan.batch;

  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    onPhase('executing', `${attempt ? '正在重试' : '正在'}${batch.tools.map((tool) => tool.prepared.label).join('、')}…`);
    const results = await registry.execute(batch, signal, (message) => onMessage(attempt ? `重试结果：${message}` : message));
    signal.throwIfAborted();
    if (attempt > 0) for (const result of results) if (result.error) result.error.retryable = false;
    history.push({ calls: batch.tools.map((tool) => tool.call), results });
    onPhase('thinking', '正在核对本轮执行结果…');
    try {
      const response = await client({ ...plan.request, tools: registry.definitions(), context: registry.context(), history }, signal);
      signal.throwIfAborted();
      if (!validRetryResponse(response, history)) {
        onMessage('已拦截超出失败动作范围的重试请求。');
        break;
      }
      if (!response.toolCalls.length) {
        if (response.reply) onMessage(`小满反馈：${response.reply}`);
        break;
      }
      const allowed = new Set(retryableCalls(history).map(operationKey));
      batch = {
        requiresConfirmation: false,
        tools: response.toolCalls.map((call) => {
          const approved = plan.batch.tools.find((tool) => allowed.has(operationKey(tool.call)) && operationKey(tool.call) === operationKey(call))!;
          return { ...approved, call: structuredClone(call) };
        }),
      };
    } catch {
      signal.throwIfAborted();
      onMessage('执行结果已保留，模型结果复核暂时不可用。');
      break;
    }
  }

  const final = new Map<string, ToolExecutionResult>();
  for (const exchange of history) {
    for (const call of exchange.calls) final.set(operationKey(call), exchange.results.find((result) => result.toolCallId === call.id)!);
  }
  const count = (status: ToolExecutionResult['status']) => [...final.values()].filter((result) => result.status === status).length;
  const summary = `最终完成${count('succeeded')}项，失败${count('failed')}项，未执行${count('not_run')}项。`;
  onMessage(summary);
  return { history, summary };
}

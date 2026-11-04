import type { ControlResponse, ToolArguments, ToolCall, ToolDefinition, ToolEffect, ToolExecutionResult } from '../../shared/control';
import { validControlResponse, validToolArguments, validToolDefinitions } from '../../shared/control';
import { PART_IDS, WINDOW_IDS } from '../contracts/vehicle';
import type { VehicleAction, VehicleController } from '../contracts/vehicle';
import { describeAction, describeResult, PART_LABELS } from './parseCommand';

export interface PreparedTool {
  label: string;
  execute(signal: AbortSignal): Promise<string>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  confirmation: 'always' | 'never';
  idempotent?: boolean;
  context?(): unknown;
  prepare(args: ToolArguments): PreparedTool;
}

export class ToolExecutionError extends Error {
  constructor(message: string, public readonly details: { code: string; retryable: boolean; effect: ToolEffect }) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

export interface PreparedToolBatch {
  tools: { call: ToolCall; prepared: PreparedTool; registered: RegisteredTool }[];
  requiresConfirmation: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): () => void {
    const name = tool.definition.function.name;
    if (!validToolDefinitions([tool.definition]) || this.tools.has(name) || this.tools.size >= 16) {
      throw new Error('Invalid or duplicate tool registration');
    }
    const registered = { ...tool, definition: structuredClone(tool.definition) };
    this.tools.set(name, registered);
    return () => { if (this.tools.get(name) === registered) this.tools.delete(name); };
  }

  definitions(): ToolDefinition[] {
    return structuredClone([...this.tools.values()].map((tool) => tool.definition));
  }

  context(): Record<string, unknown> {
    return Object.fromEntries([...this.tools].filter(([, tool]) => tool.context).map(([name, tool]) => [name, tool.context!()]));
  }

  prepare(response: ControlResponse): PreparedToolBatch {
    if (!validControlResponse(response, this.definitions())) throw new Error('Invalid tool response');
    const batch: PreparedToolBatch = { tools: [], requiresConfirmation: false };
    for (const call of response.toolCalls) {
      const tool = this.tools.get(call.name)!;
      batch.requiresConfirmation ||= tool.confirmation === 'always';
      const savedCall = structuredClone(call);
      batch.tools.push({ call: savedCall, prepared: tool.prepare(structuredClone(savedCall.arguments)), registered: tool });
    }
    return batch;
  }

  async execute(batch: PreparedToolBatch, signal: AbortSignal, onResult: (message: string) => void): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    for (const { call, prepared, registered } of batch.tools) {
      let result: ToolExecutionResult;
      if (signal.aborted) {
        result = { toolCallId: call.id, status: 'not_run', message: `${prepared.label}未执行，已取消。`, effect: 'not_applied', error: { code: 'CANCELLED', retryable: false } };
      } else if (this.tools.get(call.name) !== registered || !validToolArguments(registered.definition, call.arguments)) {
        result = { toolCallId: call.id, status: 'not_run', message: `${prepared.label}未执行，工具已失效。`, effect: 'not_applied', error: { code: 'TOOL_UNAVAILABLE', retryable: false } };
      } else {
        try {
          const message = await prepared.execute(signal);
          result = { toolCallId: call.id, status: 'succeeded', message, effect: 'applied' };
        } catch (cause) {
          const details = cause instanceof ToolExecutionError ? cause.details
            : { code: 'EXECUTION_ERROR', retryable: false, effect: 'unknown' as const };
          result = {
            toolCallId: call.id, status: 'failed', message: `${prepared.label}失败。${cause instanceof ToolExecutionError ? cause.message : '执行结果未确认。'}`,
            effect: details.effect, error: { code: signal.aborted ? 'CANCELLED' : details.code, retryable: false },
          };
          let observed = false;
          try {
            if (registered.context) { result.actualState = structuredClone(registered.context()); observed = result.actualState !== undefined; }
          } catch { /* A failed state read leaves the effect uncertain. */ }
          result.error!.retryable = !signal.aborted && details.retryable
            && (details.effect === 'not_applied' || (details.effect === 'unknown' && registered.idempotent === true && observed));
        }
      }
      if (result.status === 'succeeded' && registered.context) {
        try { result.actualState = structuredClone(registered.context()); } catch { /* Completion remains authoritative when state reads fail. */ }
      }
      results.push(result);
      onResult(result.message);
    }
    return results;
  }
}

export function createVehicleToolRegistry(
  controller: VehicleController,
  options: { confirmation?: 'always' | 'never' } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  const confirmation = options.confirmation ?? 'never';
  const prepareAction = (action: VehicleAction): PreparedTool => ({
    label: describeAction(action),
    async execute(signal) {
      if (!controller.getSnapshot().ready) throw new ToolExecutionError('车辆仍在加载。', { code: 'VEHICLE_NOT_READY', retryable: true, effect: 'not_applied' });
      const [result] = await controller.execute([action], { signal });
      if (!result || result.outcome === 'failed') throw new ToolExecutionError('车辆未能完成动作。', { code: 'VEHICLE_ACTION_FAILED', retryable: true, effect: 'unknown' });
      if (result.outcome === 'cancelled') throw new ToolExecutionError('动作已取消。', { code: 'CANCELLED', retryable: false, effect: 'not_applied' });
      return describeResult(result);
    },
  });

  registry.register({
    definition: {
      type: 'function',
      function: {
        name: 'set_window_openness',
        description: '设置指定车窗的绝对开度。0=完全关闭，0.25=打开一点，0.5=打开一半，1=完全打开；重复请求保持同一位置。all 表示全部四窗，仅在用户明确要求全部时使用。',
        parameters: {
          type: 'object', additionalProperties: false, required: ['target', 'openness'],
          properties: {
            target: { type: 'string', enum: [...WINDOW_IDS, 'all'] },
            openness: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
    confirmation, idempotent: true,
    context: () => Object.fromEntries(WINDOW_IDS.map((id) => [id, controller.getSnapshot().parts[id]])),
    prepare: (args) => prepareAction(args.target === 'all'
      ? { kind: 'group', group: 'windows', open: Number(args.openness) > 0, openness: args.openness as number }
      : { kind: 'part', partId: args.target as typeof WINDOW_IDS[number], open: Number(args.openness) > 0, openness: args.openness as number }),
  });
  registry.register({
    definition: {
      type: 'function',
      function: {
        name: 'set_vehicle_part',
        description: `开合指定部件。open=true 表示打开门、备箱或降下车窗，false 表示关闭或升窗。位置映射 ${JSON.stringify(PART_LABELS)}。`,
        parameters: {
          type: 'object', additionalProperties: false, required: ['partId', 'open'],
          properties: { partId: { type: 'string', enum: [...PART_IDS] }, open: { type: 'boolean' } },
        },
      },
    },
    confirmation,
    idempotent: true,
    context: () => controller.getSnapshot().parts,
    prepare: (args) => prepareAction({ kind: 'part', partId: args.partId as typeof PART_IDS[number], open: args.open as boolean }),
  });
  registry.register({
    definition: {
      type: 'function',
      function: {
        name: 'set_vehicle_group', description: '明确要求全部车门或全部车窗时使用。doors=所有车门，windows=所有车窗，open=true 为打开或降下。',
        parameters: {
          type: 'object', additionalProperties: false, required: ['group', 'open'],
          properties: { group: { type: 'string', enum: ['doors', 'windows'] }, open: { type: 'boolean' } },
        },
      },
    },
    confirmation,
    idempotent: true,
    context: () => controller.getSnapshot().parts,
    prepare: (args) => prepareAction({ kind: 'group', group: args.group as 'doors' | 'windows', open: args.open as boolean }),
  });
  registry.register({
    definition: {
      type: 'function',
      function: {
        name: 'set_engine_state', description: '设置演示车辆的引擎状态，running=true 为启动，false 为熄火。',
        parameters: { type: 'object', additionalProperties: false, required: ['running'], properties: { running: { type: 'boolean' } } },
      },
    },
    confirmation,
    idempotent: true,
    context: () => ({ running: controller.getSnapshot().engineRunning }),
    prepare: (args) => prepareAction({ kind: 'engine', running: args.running as boolean }),
  });
  return registry;
}

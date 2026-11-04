import type { ControlResponse, ToolArguments, ToolCall, ToolDefinition } from '../../shared/control';
import { validControlResponse, validToolArguments, validToolDefinitions } from '../../shared/control';
import { PART_IDS } from '../contracts/vehicle';
import type { VehicleAction, VehicleController } from '../contracts/vehicle';
import { describeAction, describeResult, PART_LABELS } from './parseCommand';

export interface PreparedTool {
  label: string;
  execute(signal: AbortSignal): Promise<string>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  confirmation: 'always' | 'never';
  context?(): unknown;
  prepare(args: ToolArguments): PreparedTool;
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

  async execute(batch: PreparedToolBatch, signal: AbortSignal, onResult: (message: string) => void): Promise<void> {
    for (const { call, prepared, registered } of batch.tools) {
      signal.throwIfAborted();
      if (this.tools.get(call.name) !== registered || !validToolArguments(registered.definition, call.arguments)) throw new Error('Tool is no longer available');
      const result = await prepared.execute(signal);
      signal.throwIfAborted();
      onResult(result);
    }
  }
}

export function createVehicleToolRegistry(controller: VehicleController): ToolRegistry {
  const registry = new ToolRegistry();
  const prepareAction = (action: VehicleAction): PreparedTool => ({
    label: describeAction(action),
    async execute(signal) {
      if (!controller.getSnapshot().ready) throw new Error('Vehicle is not ready');
      const [result] = await controller.execute([action], { signal });
      if (!result || result.outcome === 'failed' || result.outcome === 'cancelled') throw new Error('Vehicle action failed');
      return describeResult(result);
    },
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
    confirmation: 'always',
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
    confirmation: 'always',
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
    confirmation: 'always',
    context: () => ({ running: controller.getSnapshot().engineRunning }),
    prepare: (args) => prepareAction({ kind: 'engine', running: args.running as boolean }),
  });
  return registry;
}

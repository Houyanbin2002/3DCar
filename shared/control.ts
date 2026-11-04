export type ToolArgument = string | number | boolean;
export type ToolArguments = Record<string, ToolArgument>;

export type ToolParameter =
  | { type: 'string'; description?: string; enum?: string[] }
  | { type: 'number'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParameter>;
      required: string[];
      additionalProperties: false;
    };
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: ToolArguments;
}

export interface ControlRequest {
  text: string;
  tools: ToolDefinition[];
  context: Record<string, unknown>;
  dialogue?: DialogueMessage[];
  history?: ToolExchange[];
}

export interface DialogueMessage { role: 'user' | 'assistant'; content: string }

export function validDialogue(value: unknown): value is DialogueMessage[] {
  if (!Array.isArray(value) || value.length > 12 || value.length % 2 !== 0) return false;
  let length = 0;
  return value.every((message, index) => {
    if (!isRecord(message) || Object.keys(message).length !== 2
      || message.role !== (index % 2 === 0 ? 'user' : 'assistant')
      || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 1000) return false;
    length += message.content.length;
    return length <= 6000;
  });
}

export interface ControlResponse {
  toolCalls: ToolCall[];
  reply: string;
}

export type ToolEffect = 'applied' | 'not_applied' | 'unknown';

export interface ToolExecutionResult {
  toolCallId: string;
  status: 'succeeded' | 'failed' | 'not_run';
  message: string;
  effect: ToolEffect;
  error?: { code: string; retryable: boolean };
  actualState?: unknown;
}

export interface ToolExchange {
  calls: ToolCall[];
  results: ToolExecutionResult[];
}

export function operationKey(call: ToolCall): string {
  return JSON.stringify([call.name, Object.entries(call.arguments).sort(([left], [right]) => left.localeCompare(right))]);
}

export function retryableCalls(history: readonly ToolExchange[]): ToolCall[] {
  if (history.length !== 1) return [];
  const { calls, results } = history[0];
  const succeeded = new Set(results.filter((result) => result.status === 'succeeded')
    .map((result) => operationKey(calls.find((call) => call.id === result.toolCallId)!)));
  return calls.filter((call) => {
    const result = results.find((item) => item.toolCallId === call.id)!;
    return result.status === 'failed' && result.error?.retryable === true && !succeeded.has(operationKey(call));
  });
}

export function validRetryResponse(response: ControlResponse, history: readonly ToolExchange[]): boolean {
  if (!response.toolCalls.length) return true;
  const allowed = new Set(retryableCalls(history).map(operationKey));
  const previousIds = new Set(history.flatMap((exchange) => exchange.calls.map((call) => call.id)));
  const seen = new Set<string>();
  return response.toolCalls.every((call) => {
    const key = operationKey(call);
    if (!allowed.has(key) || seen.has(key) || previousIds.has(call.id)) return false;
    seen.add(key);
    return true;
  });
}

export function validToolHistory(value: unknown, definitions: readonly ToolDefinition[]): value is ToolExchange[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return false;
  const previous: ToolExchange[] = [];
  for (const exchange of value) {
    if (!isRecord(exchange) || Object.keys(exchange).length !== 2 || !Array.isArray(exchange.results)
      || !validControlResponse({ toolCalls: exchange.calls, reply: '' }, definitions)
      || !Array.isArray(exchange.calls) || exchange.calls.length < 1 || exchange.calls.length !== exchange.results.length) return false;
    const ids = new Set<string>();
    for (const result of exchange.results) {
      if (!isRecord(result) || Object.keys(result).some((key) => !['toolCallId', 'status', 'message', 'effect', 'error', 'actualState'].includes(key))
        || typeof result.toolCallId !== 'string' || ids.has(result.toolCallId)
        || !exchange.calls.some((call: ToolCall) => call.id === result.toolCallId)
        || !['succeeded', 'failed', 'not_run'].includes(String(result.status))
        || !['applied', 'not_applied', 'unknown'].includes(String(result.effect))
        || typeof result.message !== 'string' || result.message.length > 1_000) return false;
      ids.add(result.toolCallId);
      if (result.status === 'succeeded') {
        if (result.effect !== 'applied' || result.error !== undefined) return false;
      } else {
        if (!isRecord(result.error) || Object.keys(result.error).length !== 2
          || typeof result.error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(result.error.code)
          || typeof result.error.retryable !== 'boolean') return false;
        if (result.status === 'not_run' && (result.effect !== 'not_applied' || result.error.retryable)) return false;
        if (result.effect === 'applied' && result.error.retryable) return false;
        if (result.effect === 'unknown' && result.error.retryable && result.actualState === undefined) return false;
        if (previous.length > 0 && result.error.retryable) return false;
      }
    }
    const checked = exchange as unknown as ToolExchange;
    if (previous.length && !validRetryResponse({ toolCalls: checked.calls, reply: '' }, previous)) return false;
    previous.push(checked);
  }
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const identifier = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/u;

export function validToolDefinitions(value: unknown): value is ToolDefinition[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return false;
  const names = new Set<string>();
  for (const tool of value) {
    if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) return false;
    const definition = tool.function;
    if (typeof definition.name !== 'string' || !identifier.test(definition.name) || names.has(definition.name)
      || typeof definition.description !== 'string' || definition.description.length > 1_000) return false;
    names.add(definition.name);
    const schema = definition.parameters;
    if (!isRecord(schema) || schema.type !== 'object' || schema.additionalProperties !== false
      || !isRecord(schema.properties) || !Array.isArray(schema.required)
      || Object.keys(schema.properties).length > 16) return false;
    if (new Set(schema.required).size !== schema.required.length
      || schema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(schema.properties as object, key))) return false;
    for (const [name, parameter] of Object.entries(schema.properties)) {
      if (!identifier.test(name) || !isRecord(parameter)
        || !['string', 'number', 'boolean'].includes(String(parameter.type))) return false;
      if (parameter.description !== undefined && (typeof parameter.description !== 'string' || parameter.description.length > 500)) return false;
      if (parameter.enum !== undefined && (parameter.type !== 'string' || !Array.isArray(parameter.enum)
        || parameter.enum.length < 1 || parameter.enum.length > 64
        || parameter.enum.some((item) => typeof item !== 'string' || item.length > 200))) return false;
      if (parameter.minimum !== undefined && (parameter.type !== 'number' || typeof parameter.minimum !== 'number' || !Number.isFinite(parameter.minimum))) return false;
      if (parameter.maximum !== undefined && (parameter.type !== 'number' || typeof parameter.maximum !== 'number' || !Number.isFinite(parameter.maximum))) return false;
      if (typeof parameter.minimum === 'number' && typeof parameter.maximum === 'number' && parameter.minimum > parameter.maximum) return false;
    }
  }
  return true;
}

export function validToolArguments(definition: ToolDefinition, value: unknown): value is ToolArguments {
  if (!isRecord(value)) return false;
  const schema = definition.function.parameters;
  if (schema.required.some((key) => !Object.hasOwn(value, key))) return false;
  for (const [key, argument] of Object.entries(value)) {
    if (!Object.hasOwn(schema.properties, key)) return false;
    const parameter = schema.properties[key];
    if (typeof argument !== parameter.type) return false;
    if (parameter.type === 'string' && (typeof argument !== 'string' || argument.length > 1_000
      || (parameter.enum && !parameter.enum.includes(argument)))) return false;
    if (parameter.type === 'number' && (typeof argument !== 'number' || !Number.isFinite(argument)
      || (parameter.minimum !== undefined && argument < parameter.minimum)
      || (parameter.maximum !== undefined && argument > parameter.maximum))) return false;
  }
  return true;
}

export function validControlResponse(value: unknown, definitions: readonly ToolDefinition[]): value is ControlResponse {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Array.isArray(value.toolCalls)
    || value.toolCalls.length > 8 || typeof value.reply !== 'string' || value.reply.length > 1_000) return false;
  const ids = new Set<string>();
  for (const call of value.toolCalls) {
    if (!isRecord(call) || Object.keys(call).length !== 3 || typeof call.id !== 'string'
      || !call.id || call.id.length > 200 || ids.has(call.id) || typeof call.name !== 'string') return false;
    const definition = definitions.find((tool) => tool.function.name === call.name);
    if (!definition || !validToolArguments(definition, call.arguments)) return false;
    ids.add(call.id);
  }
  return value.toolCalls.length > 0 || value.reply.trim().length > 0;
}

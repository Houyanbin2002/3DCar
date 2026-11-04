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
}

export interface ControlResponse {
  toolCalls: ToolCall[];
  reply: string;
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

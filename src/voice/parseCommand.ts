import type { PartId, VehicleAction, VehicleActionResult } from '../contracts/vehicle';

export const PART_LABELS: Record<PartId, string> = {
  frontLeftDoor: '左前门', frontRightDoor: '右前门',
  rearLeftDoor: '左后门', rearRightDoor: '右后门',
  frontLeftWindow: '左前窗', frontRightWindow: '右前窗',
  rearLeftWindow: '左后窗', rearRightWindow: '右后窗',
  frunk: '前备箱', trunk: '后备箱',
};

type Target =
  | { kind: 'part'; partId: PartId }
  | { kind: 'group'; group: 'doors' | 'windows' };

const targets: [string, Target][] = [];
for (const [partId, label] of Object.entries(PART_LABELS)) {
  const target: Target = { kind: 'part', partId: partId as PartId };
  targets.push([label, target]);
  if (label.endsWith('门')) targets.push([label.replace('门', '车门'), target]);
  if (label.endsWith('窗')) targets.push([label.replace('窗', '车窗'), target]);
}
for (const prefix of ['所有', '全部', '全车']) {
  for (const suffix of ['车门', '门']) targets.push([prefix + suffix, { kind: 'group', group: 'doors' }]);
  for (const suffix of ['车窗', '窗户', '窗']) targets.push([prefix + suffix, { kind: 'group', group: 'windows' }]);
}
targets.push(['前行李箱', { kind: 'part', partId: 'frunk' }]);
targets.push(['后行李箱', { kind: 'part', partId: 'trunk' }]);
targets.push(['尾箱', { kind: 'part', partId: 'trunk' }]);
targets.sort((a, b) => b[0].length - a[0].length);

const verbs = /^(打开|开启|关上|关掉|关闭|降下|摇下|落下|升起|升上|摇上|开|关)/u;
const engine = /^(启动引擎|启动发动机|启动车辆|关闭引擎|关闭发动机|停止引擎|熄火)/u;
const cancellation = /不要|不用|不需要|不想|取消|算了|^(?:请|千万)?别/u;

export type ParsedCommand =
  | { kind: 'commands'; actions: VehicleAction[]; messages: string[] }
  | { kind: 'clarify'; message: string }
  | { kind: 'indirect'; text: string }
  | { kind: 'cancelled' };

export type RoutedStep =
  | { source: 'rule'; confidence: 'high'; actions: VehicleAction[] }
  | { source: 'model'; confidence: 'low' | 'unmatched'; text: string };

export function routeCommand(text: string): { cancelled: boolean; steps: RoutedStep[] } {
  if (cancellation.test(normalizeSpeech(text))) return { cancelled: true, steps: [] };
  const chunks = text.replace(/[，,。；;、！？!?]/gu, '|')
    .split(/(然后|接着|再|并且|以及|还有|和|并|\|+)/u);
  const steps: RoutedStep[] = [];
  let inheritedOpen: boolean | undefined;
  for (let index = 0; index < chunks.length; index += 2) {
    const original = chunks[index].trim();
    const clause = cleanClause(original);
    if (!clause) continue;
    const shared = /^(和|以及|还有)$/u.test(chunks[index - 1] ?? '') ? inheritedOpen : undefined;
    const actions = parseClause(clause, shared);
    if (actions) {
      const previous = steps.at(-1);
      if (previous?.source === 'rule') previous.actions.push(...actions);
      else steps.push({ source: 'rule', confidence: 'high', actions });
      const last = actions.at(-1)!;
      inheritedOpen = last.kind === 'engine' ? undefined : last.open;
    } else {
      inheritedOpen = undefined;
      const previous = steps.at(-1);
      if (previous?.source === 'model') previous.text += `，${original}`;
      else steps.push({ source: 'model', confidence: /门|窗|备箱|引擎|打开|关闭/u.test(clause) ? 'low' : 'unmatched', text: original });
    }
  }
  return { cancelled: false, steps };
}

export function normalizeSpeech(text: string): string {
  return text.replace(/[\s\p{P}]/gu, '');
}

export function extractWakeCommand(text: string): string | null {
  const wake = /小[\s\p{P}]*满[\s\p{P}]*同[\s\p{P}]*学/gu;
  const matches = [...text.matchAll(wake)];
  const match = matches.at(-1);
  return match ? text.slice(match.index + match[0].length) : null;
}

function cleanClause(text: string): string {
  return normalizeSpeech(text)
    .replace(/^(?:请你|麻烦你|帮我|帮忙|请|把|能不能)+/u, '')
    .replace(/(?:一下|好吗|谢谢|可以吗|行吗|吧)+$/u, '');
}

function parseClause(text: string, inheritedOpen?: boolean): VehicleAction[] | null {
  let rest = text;
  const actions: VehicleAction[] = [];
  while (rest) {
    const engineMatch = rest.match(engine);
    if (engineMatch) {
      actions.push({ kind: 'engine', running: engineMatch[0].startsWith('启动') });
      rest = rest.slice(engineMatch[0].length);
      inheritedOpen = undefined;
      continue;
    }
    const verb = rest.match(verbs)?.[0];
    if (verb) rest = rest.slice(verb.length);
    const open = verb ? /^(打开|开启|降下|摇下|落下|开)$/u.test(verb) : inheritedOpen;
    const target = targets.find(([word]) => rest.startsWith(word));
    if (open === undefined || !target) return null;
    const [word, definition] = target;
    const windowVerb = verb && /降|摇|落|升/u.test(verb);
    const isWindow = definition.kind === 'group'
      ? definition.group === 'windows' : definition.partId.endsWith('Window');
    if (windowVerb && !isWindow) return null;
    actions.push({ ...definition, open });
    rest = rest.slice(word.length);
    // Sharing an action requires an explicit connector between the targets.
    inheritedOpen = undefined;
  }
  return actions.length ? actions : null;
}

export function parseCommand(text: string): ParsedCommand {
  const normalized = normalizeSpeech(text);
  if (cancellation.test(normalized)) return { kind: 'cancelled' };
  const chunks = text.replace(/[，,。；;、！？!?]/gu, '|')
    .split(/(然后|接着|再|并且|以及|还有|和|并|\|+)/u);
  const actions: VehicleAction[] = [];
  const messages: string[] = [];
  let recognizedWords = false;
  let inheritedOpen: boolean | undefined;
  for (let index = 0; index < chunks.length; index += 2) {
    const clause = cleanClause(chunks[index]);
    if (!clause) continue;
    const connector = chunks[index - 1];
    const shared = /^(和|以及|还有)$/u.test(connector ?? '') ? inheritedOpen : undefined;
    const parsed = parseClause(clause, shared);
    if (parsed) {
      actions.push(...parsed);
      const last = parsed.at(-1)!;
      inheritedOpen = last.kind === 'engine' ? undefined : last.open;
    } else {
      inheritedOpen = undefined;
      recognizedWords ||= /打开|关闭|开启|关|降|升|摇|门|窗|备箱|行李箱|引擎|发动机|启动/u.test(clause);
      const message = /^(?:打开|开启|关闭|关上|关掉|开|关|降下|升起)$/u.test(clause)
        ? '请说要操作哪个部件，例如打开左前门。'
        : /窗/u.test(clause)
          ? '请指定哪扇车窗，或说打开所有车窗。'
          : '指令不明确，可以说打开左前门。';
      messages.push(message);
    }
  }
  if (actions.length) return { kind: 'commands', actions, messages };
  if (!recognizedWords && normalized.length >= 3) {
    return { kind: 'indirect', text: text.trim() };
  }
  return { kind: 'clarify', message: messages[0] ?? '没听清，可以说打开左前门。' };
}

export function describeAction(action: VehicleAction): string {
  if (action.kind === 'engine') return action.running ? '启动引擎' : '熄火';
  const label = action.kind === 'part' ? PART_LABELS[action.partId]
    : action.group === 'doors' ? '所有车门' : '所有车窗';
  const isWindow = action.kind === 'part' ? action.partId.endsWith('Window') : action.group === 'windows';
  const verb = isWindow ? (action.open ? '降下' : '升起') : (action.open ? '打开' : '关闭');
  return verb + label;
}

export function describeResult(result: VehicleActionResult): string {
  const label = describeAction(result.action);
  if (result.outcome === 'failed') return `${label}失败，请重试。`;
  if (result.outcome === 'cancelled') return `${label}已取消。`;
  return result.outcome === 'already-at-target' ? `${label}：已是该状态。` : `${label}完成。`;
}

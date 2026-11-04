import type { VehicleAction, VehicleController } from '../contracts/vehicle';
import { IntentClientError } from './intentClient';
import { createControlClient } from './controlClient';
import type { ControlClient } from './controlClient';
import { describeAction, describeResult, extractWakeCommand, normalizeSpeech, routeCommand } from './parseCommand';
import type { RoutedStep } from './parseCommand';
import { createVehicleToolRegistry } from './toolRegistry';
import type { ToolRegistry } from './toolRegistry';
import { runToolCycle } from './runToolCycle';
import type { ToolExecutionPlan } from './runToolCycle';
import { createBrowserSpeechInput, createBrowserSpeechOutput } from './speechIO';
import type { SpeechInput, SpeechOutput, TranscriptUpdate } from './speechIO';

export type VoicePhase = 'off' | 'starting' | 'waiting' | 'listening' | 'thinking'
  | 'speaking' | 'confirming' | 'executing' | 'error' | 'unsupported';

export interface VoiceSnapshot {
  readonly phase: VoicePhase;
  readonly enabled: boolean;
  readonly transcript: string;
  readonly message: string;
  readonly feedback: readonly string[];
}

export interface VoiceClock {
  schedule(callback: () => void, milliseconds: number): () => void;
}

export interface VoiceControlOptions {
  controller: VehicleController;
  input?: SpeechInput;
  output?: SpeechOutput;
  controlClient?: ControlClient;
  tools?: ToolRegistry;
  clock?: VoiceClock;
  timing?: Partial<typeof defaultTiming>;
}

const defaultTiming = { wakeMs: 5_000, settleMs: 1_000, confirmMs: 5_000, turnMs: 20_000, restartMs: 300 };
type TimerName = 'wake' | 'settle' | 'confirm' | 'turn' | 'restart' | 'fragment';
const defaultClock: VoiceClock = {
  schedule(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

const errors: Record<string, string> = {
  'not-allowed': '麦克风权限被拒绝，请在浏览器中允许访问后重新开启。',
  'service-not-allowed': '浏览器当前禁止语音识别，请检查浏览器设置。',
  'audio-capture': '无法使用麦克风，请检查设备连接和系统权限。',
  network: '语音识别网络异常，请检查网络后重新开启。',
  'language-not-supported': '当前语音服务不支持中文，请更换浏览器后重试。',
  unsupported: '当前浏览器未提供语音识别，请使用桌面 Chrome 或 Edge。',
};

export class VoiceControl {
  private readonly controller: VehicleController;
  private readonly input: SpeechInput;
  private readonly output: SpeechOutput;
  private readonly controlClient: ControlClient;
  private readonly tools: ToolRegistry;
  private readonly clock: VoiceClock;
  private readonly timing: typeof defaultTiming;
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<TimerName, () => void>();
  private session = 0;
  private turn = 0;
  private inputActive = false;
  private speechActive = false;
  private hasInterim = false;
  private commandText = '';
  private wakeFragment = '';
  private pendingTools: ToolExecutionPlan | null = null;
  private steps: RoutedStep[] = [];
  private abort = new AbortController();
  private snapshot: VoiceSnapshot;

  constructor(options: VoiceControlOptions) {
    this.controller = options.controller;
    this.input = options.input ?? createBrowserSpeechInput();
    this.output = options.output ?? createBrowserSpeechOutput();
    this.controlClient = options.controlClient ?? createControlClient();
    this.tools = options.tools ?? createVehicleToolRegistry(options.controller);
    this.clock = options.clock ?? defaultClock;
    this.timing = { ...defaultTiming, ...options.timing };
    this.snapshot = {
      phase: this.input.supported ? 'off' : 'unsupported', enabled: false,
      transcript: '', feedback: [], message: this.input.supported ? '开启后说“小满同学”唤醒。' : errors.unsupported,
    };
  }

  readonly getSnapshot = (): VoiceSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly start = (): void => {
    if (this.snapshot.enabled) return;
    if (!this.input.supported) { this.update({ phase: 'unsupported', message: errors.unsupported }); return; }
    this.update({ enabled: true, phase: 'starting', message: '正在开启麦克风…', feedback: [] });
    this.startInput();
  };

  readonly stop = (): void => {
    this.update({ enabled: false, phase: this.input.supported ? 'off' : 'unsupported',
      message: this.input.supported ? '语音已关闭。' : errors.unsupported });
    this.clearTurn();
    this.pauseInput();
  };

  readonly cancel = (): void => {
    if (this.snapshot.enabled) this.finish('本轮已取消，请说“小满同学”重新唤醒。');
  };

  readonly confirm = (accepted: boolean): void => {
    if (this.snapshot.phase !== 'confirming' || !this.pendingTools) return;
    const pending = this.pendingTools;
    this.pendingTools = null;
    this.cancelTimer('confirm');
    if (!accepted) { this.finish('已取消本轮建议。'); return; }
    void this.executeConfirmed(pending);
  };

  private update(change: Partial<VoiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }

  private schedule(name: TimerName, delay: number, callback: () => void): void {
    this.cancelTimer(name);
    this.timers.set(name, this.clock.schedule(() => { this.timers.delete(name); callback(); }, delay));
  }

  private cancelTimer(name: TimerName): void {
    this.timers.get(name)?.();
    this.timers.delete(name);
  }

  private clearTurn(): void {
    this.turn += 1;
    this.abort.abort();
    this.abort = new AbortController();
    this.pendingTools = null;
    this.steps = [];
    this.commandText = '';
    this.wakeFragment = '';
    this.hasInterim = false;
    for (const name of ['wake', 'settle', 'confirm', 'turn', 'fragment'] as const) this.cancelTimer(name);
  }

  private current(turn: number): boolean {
    return this.snapshot.enabled && this.turn === turn;
  }

  private pauseInput(): void {
    this.cancelTimer('restart');
    this.session += 1;
    this.inputActive = this.speechActive = false;
    this.input.stop();
  }

  private startInput(): void {
    if (!this.snapshot.enabled || this.snapshot.phase === 'speaking' || this.inputActive) return;
    this.cancelTimer('restart');
    const session = ++this.session;
    this.inputActive = true;
    const active = () => this.snapshot.enabled && session === this.session;
    try {
      this.input.start({
        onStart: () => {
          if (active() && this.snapshot.phase === 'starting') {
            this.update({ phase: 'waiting', message: '等待唤醒，说“小满同学”。' });
          }
        },
        onEnd: () => {
          if (!active()) return;
          this.session += 1;
          this.inputActive = this.speechActive = this.hasInterim = false;
          this.settle();
          this.schedule('restart', this.timing.restartMs, () => this.startInput());
        },
        onSpeechStart: () => {
          if (!active()) return;
          this.speechActive = true;
          if (this.snapshot.phase === 'listening') {
            this.cancelTimer('wake');
            this.cancelTimer('settle');
          }
        },
        onSpeechEnd: () => { if (active()) { this.speechActive = false; this.settle(); } },
        onTranscript: (update) => { if (active()) this.receive(update); },
        onError: (code) => { if (active()) this.inputError(code); },
      });
    } catch {
      this.inputError('start-failed');
    }
  }

  private inputError(code: string): void {
    if (code === 'aborted') return;
    if (code === 'no-speech') {
      if (this.snapshot.phase === 'waiting') {
        this.update({ message: this.snapshot.transcript
          ? '尚未确认唤醒词，请说“小满同学”，稍停顿后再说指令。'
          : '暂未识别到语音，请检查麦克风输入，再说“小满同学”。' });
      }
      return;
    }
    this.update({ enabled: false, phase: code === 'unsupported' ? 'unsupported' : 'error',
      message: errors[code] ?? '语音服务启动失败，请重新开启。' });
    this.clearTurn();
    this.pauseInput();
  }

  private beginTurn(remainder: string): void {
    this.clearTurn();
    this.update({ phase: 'listening', transcript: '', feedback: [], message: '我在听，请说控车指令。' });
    this.schedule('wake', this.timing.wakeMs, () => this.finish('本次聆听超时，请再说一次“小满同学”。'));
    this.schedule('turn', this.timing.turnMs, () => this.finish('本轮聆听已超时，请说一句简短的控车指令。'));
    if (normalizeSpeech(remainder)) this.appendCommand(remainder);
  }

  private appendCommand(text: string): void {
    if (!normalizeSpeech(text)) return;
    this.cancelTimer('wake');
    this.commandText += text;
    this.update({ transcript: this.commandText });
  }

  private receive(update: TranscriptUpdate): void {
    for (const text of update.finals) {
      const heard = this.snapshot.phase === 'waiting' ? this.wakeFragment + text : text;
      const remainder = extractWakeCommand(heard);
      if (remainder !== null) {
        this.beginTurn(remainder);
      } else if (this.snapshot.phase === 'waiting') {
        const normalized = normalizeSpeech(heard);
        this.wakeFragment = ['小满同', '小满', '小'].find((prefix) => normalized.endsWith(prefix)) ?? '';
        this.cancelTimer('fragment');
        if (this.wakeFragment) this.schedule('fragment', 2_000, () => { this.wakeFragment = ''; });
        this.update({ transcript: text, message: '已收到语音，请说“小满同学”唤醒。' });
      } else if (this.snapshot.phase === 'listening') {
        this.appendCommand(text);
      } else if (this.snapshot.phase === 'confirming') {
        const reply = normalizeSpeech(text);
        if (/^(需要|好的|好|是的|可以|打开吧|降下吧|确认)$/u.test(reply)) this.confirm(true);
        else if (/^(不用|不需要|不要|取消|算了)$/u.test(reply)) this.confirm(false);
        else this.update({ message: '请回答“需要”或“不用”。' });
      } else if (/^(取消|算了|不用)$/u.test(normalizeSpeech(text))
        && ['thinking', 'executing'].includes(this.snapshot.phase)) {
        this.cancel();
      }
    }
    this.hasInterim = Boolean(normalizeSpeech(update.interim));
    if (this.snapshot.phase === 'waiting' && this.hasInterim) {
      const transcript = this.wakeFragment + update.interim;
      this.update({ transcript, message: extractWakeCommand(transcript) !== null
        ? '已听到“小满同学”，正在等待完整识别结果…'
        : '已收到语音，正在识别唤醒词…' });
    }
    if (this.snapshot.phase === 'listening' && this.hasInterim) {
      this.cancelTimer('wake');
      this.cancelTimer('settle');
      this.update({ transcript: this.commandText + update.interim });
    }
    this.settle();
  }

  private settle(): void {
    if (this.snapshot.phase !== 'listening' || !this.commandText || this.hasInterim || this.speechActive) return;
    this.schedule('settle', this.timing.settleMs, () => { void this.processCommand(); });
  }

  private async processCommand(): Promise<void> {
    const text = this.commandText;
    this.cancelTimer('turn');
    this.cancelTimer('wake');
    const route = routeCommand(text);
    if (route.cancelled) { this.finish('本轮已取消。'); return; }
    this.steps = route.steps;
    await this.advance();
  }

  private addFeedback(message: string): void {
    this.update({ feedback: [...this.snapshot.feedback, message], message });
  }

  private async advance(): Promise<void> {
    const turn = this.turn;
    while (this.current(turn) && this.steps.length) {
      const step = this.steps.shift()!;
      if (step.source === 'rule') await this.executeActions(step.actions);
      else if (await this.planTools(step.text)) return;
    }
    if (this.current(turn)) this.finish(this.snapshot.feedback.join(' ') || '没听清，可以说打开左前门。');
  }

  private async executeActions(actions: readonly VehicleAction[]): Promise<void> {
    if (!this.controller.getSnapshot().ready) { this.addFeedback('车辆仍在加载，请稍后重试。'); return; }
    const turn = this.turn;
    const previousCount = this.snapshot.feedback.length;
    this.update({ phase: 'executing', message: `正在${describeAction(actions[0])}…` });
    try {
      const results = await this.controller.execute(actions, {
        signal: this.abort.signal,
        onResult: (result) => {
          if (!this.current(turn)) return;
          this.addFeedback(describeResult(result));
        },
      });
      if (!this.current(turn)) return;
      if (this.snapshot.feedback.length === previousCount) {
        for (const result of results) this.addFeedback(describeResult(result));
      }
    } catch {
      if (this.current(turn)) this.addFeedback('本次动作未能完成，请稍后重试。');
    }
  }

  private async executeToolBatch(plan: ToolExecutionPlan): Promise<void> {
    const turn = this.turn;
    try {
      await runToolCycle({
        plan, registry: this.tools, client: this.controlClient, signal: this.abort.signal,
        onMessage: (message) => { if (this.current(turn)) this.addFeedback(message); },
        onPhase: (phase, message) => { if (this.current(turn)) this.update({ phase, message }); },
      });
    } catch {
      if (this.current(turn)) this.addFeedback('本次工具动作未能完成，请重新唤醒后重试。');
    }
  }

  private async executeConfirmed(plan: ToolExecutionPlan): Promise<void> {
    const turn = this.turn;
    await this.executeToolBatch(plan);
    if (this.current(turn)) await this.advance();
  }

  private async planTools(text: string): Promise<boolean> {
    const turn = this.turn;
    this.update({ phase: 'thinking', message: '正在理解你的意思…' });
    try {
      const request = { text, tools: this.tools.definitions(), context: this.tools.context() };
      const response = await this.controlClient(request, this.abort.signal);
      if (!this.current(turn)) return false;
      const batch = this.tools.prepare(response);
      if (!batch.tools.length) {
        this.addFeedback(`未执行车辆动作。${response.reply}`);
        return false;
      }
      const plan = { batch, request };
      if (!batch.requiresConfirmation) { await this.executeToolBatch(plan); return false; }
      this.pendingTools = plan;
      const question = `要我帮你${batch.tools.map(({ prepared }) => prepared.label).join('、')}吗？`;
      this.pauseInput();
      this.update({ phase: 'speaking', message: question });
      try { await this.output.speak(question, this.abort.signal); } catch { /* The visible question also supports confirmation. */ }
      if (!this.current(turn)) return false;
      this.update({ phase: 'confirming', message: question });
      this.startInput();
      if (this.current(turn)) {
        this.schedule('confirm', this.timing.confirmMs, () => this.finish('确认超时，已取消本轮建议。'));
      }
      return true;
    } catch (error) {
      if (!this.current(turn)) return false;
      const reason = error instanceof IntentClientError && error.code === 'rate-limited'
        ? '智能建议使用较频繁，请稍后再试。' : '智能建议暂时不可用。';
      this.addFeedback(`${reason}可以直接说“打开左前窗”。`);
      return false;
    }
  }

  private finish(message: string, feedback: readonly string[] = this.snapshot.feedback): void {
    this.clearTurn();
    this.update({ phase: 'waiting', message, feedback });
    this.startInput();
  }
}

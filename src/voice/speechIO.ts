export interface TranscriptUpdate {
  finals: readonly string[];
  interim: string;
}

export interface SpeechInputEvents {
  onStart(): void;
  onEnd(): void;
  onSpeechStart(): void;
  onSpeechEnd(): void;
  onTranscript(update: TranscriptUpdate): void;
  onError(code: string): void;
}

export interface SpeechInput {
  readonly supported: boolean;
  start(events: SpeechInputEvents): void;
  stop(): void;
}

export interface SpeechOutput {
  speak(text: string, signal: AbortSignal): Promise<void>;
}

interface NativeResult {
  isFinal: boolean;
  0: { transcript: string };
}

export interface NativeRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<NativeResult> }) => void) | null;
  start(): void;
  abort(): void;
}

type RecognitionConstructor = new () => NativeRecognition;

export function createBrowserSpeechInput(
  constructor?: RecognitionConstructor,
): SpeechInput {
  const browser = globalThis as typeof globalThis & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  const Recognition = constructor ?? browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  let current: NativeRecognition | null = null;

  const stop = () => {
    const recognition = current;
    current = null;
    if (!recognition) return;
    recognition.onstart = recognition.onend = recognition.onspeechstart = recognition.onspeechend = null;
    recognition.onerror = recognition.onresult = null;
    try { recognition.abort(); } catch { /* The browser may have already ended the session. */ }
  };

  return {
    supported: Boolean(Recognition),
    stop,
    start(events) {
      stop();
      if (!Recognition) { events.onError('unsupported'); return; }
      const recognition = new Recognition();
      current = recognition;
      recognition.lang = 'zh-CN';
      recognition.continuous = true;
      recognition.interimResults = true;
      const delivered = new Set<number>();
      recognition.onstart = () => { if (current === recognition) events.onStart(); };
      recognition.onend = () => {
        if (current !== recognition) return;
        current = null;
        events.onEnd();
      };
      recognition.onspeechstart = () => { if (current === recognition) events.onSpeechStart(); };
      recognition.onspeechend = () => { if (current === recognition) events.onSpeechEnd(); };
      recognition.onerror = (event) => { if (current === recognition) events.onError(event.error); };
      recognition.onresult = (event) => {
        if (current !== recognition) return;
        const finals: string[] = [];
        let interim = '';
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result.isFinal) {
            if (index >= event.resultIndex && !delivered.has(index)) {
              delivered.add(index);
              finals.push(result[0].transcript);
            }
          } else {
            interim += result[0].transcript;
          }
        }
        events.onTranscript({ finals, interim });
      };
      try { recognition.start(); }
      catch { stop(); events.onError('start-failed'); }
    },
  };
}

export function createBrowserSpeechOutput(): SpeechOutput {
  return {
    speak(text, signal) {
      if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
      if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'zh-CN';
        let finished = false;
        const finish = (aborted = false) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
          utterance.onend = utterance.onerror = null;
          if (aborted) {
            speechSynthesis.cancel();
            reject(new DOMException('Aborted', 'AbortError'));
          } else {
            resolve();
          }
        };
        const abort = () => finish(true);
        const timeout = setTimeout(() => { speechSynthesis.cancel(); finish(); }, 10_000);
        signal.addEventListener('abort', abort, { once: true });
        utterance.onend = () => finish();
        utterance.onerror = () => finish();
        try { speechSynthesis.speak(utterance); } catch { finish(); }
      });
    },
  };
}

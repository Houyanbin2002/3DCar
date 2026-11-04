import { handleIntent } from './intent.js';
import { handleSpeech } from './speech.js';
import type { SpeechEnvironment } from './speech.js';
import { SPEECH_PATH } from '../shared/speech.js';

export { IntentQuota } from './quota.js';

export default {
  fetch(request: Request, environment: SpeechEnvironment): Promise<Response> {
    if (new URL(request.url).pathname === SPEECH_PATH) return handleSpeech(request, environment);
    return handleIntent(request, environment);
  },
};

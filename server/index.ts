import { handleIntent } from './intent.js';
import type { IntentEnvironment } from './intent.js';

export { IntentQuota } from './quota.js';

export default {
  fetch(request: Request, environment: IntentEnvironment): Promise<Response> {
    return handleIntent(request, environment);
  },
};

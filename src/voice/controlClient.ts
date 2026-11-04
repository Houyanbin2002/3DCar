import type { ControlRequest, ControlResponse } from '../../shared/control';
import { validControlResponse, validRetryResponse, validToolDefinitions, validToolHistory, validDialogue } from '../../shared/control';
import { createGatewayTransport, IntentClientError } from './intentClient';
import type { GatewayOptions } from './intentClient';

export type ControlClient = (request: ControlRequest, signal: AbortSignal) => Promise<ControlResponse>;

export function createControlClient(options: GatewayOptions = {}): ControlClient {
  const send = createGatewayTransport(options);
  return async (request, signal) => {
    if (!validToolDefinitions(request.tools)) throw new IntentClientError('invalid-response');
    if (request.dialogue && !validDialogue(request.dialogue)) throw new IntentClientError('invalid-response');
    if (request.history && !validToolHistory(request.history, request.tools)) throw new IntentClientError('invalid-response');
    const result = await send(request, signal);
    if (!validControlResponse(result, request.tools)) throw new IntentClientError('invalid-response');
    if (request.history && !validRetryResponse(result, request.history)) throw new IntentClientError('invalid-response');
    return result;
  };
}

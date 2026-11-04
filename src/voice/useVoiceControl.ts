import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { VoiceControl } from './VoiceControl';
import type { VoiceControlOptions } from './VoiceControl';

export function useVoiceControl(options: VoiceControlOptions) {
  const { controller, input, output, intentClient, clock, timing } = options;
  const control = useMemo(
    () => new VoiceControl({ controller, input, output, intentClient, clock, timing }),
    [controller, input, output, intentClient, clock, timing],
  );
  const snapshot = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  // stop() is reversible so StrictMode's setup/cleanup cycle can safely reuse the control.
  useEffect(() => () => control.stop(), [control]);
  return { snapshot, start: control.start, stop: control.stop, confirm: control.confirm, cancel: control.cancel };
}

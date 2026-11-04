export const DOOR_IDS = [
  'frontLeftDoor',
  'frontRightDoor',
  'rearLeftDoor',
  'rearRightDoor',
] as const;

export const WINDOW_IDS = [
  'frontLeftWindow',
  'frontRightWindow',
  'rearLeftWindow',
  'rearRightWindow',
] as const;

export const PART_IDS = [...DOOR_IDS, ...WINDOW_IDS, 'frunk', 'trunk'] as const;

export type PartId = (typeof PART_IDS)[number];
export type WindowId = (typeof WINDOW_IDS)[number];
/** 0 is fully raised, 1 is fully lowered. */
export type WindowOpenness = number;

export type VehicleAction =
  | { kind: 'part'; partId: PartId; open: boolean; openness?: WindowOpenness }
  | { kind: 'group'; group: 'doors' | 'windows'; open: boolean; openness?: WindowOpenness }
  | { kind: 'engine'; running: boolean };

export interface PartSnapshot {
  readonly open: boolean;
  readonly targetOpen: boolean;
  readonly moving: boolean;
  readonly openness?: number;
  readonly targetOpenness?: number;
}

export interface VehicleSnapshot {
  readonly ready: boolean;
  readonly engineRunning: boolean;
  readonly supportsWindowGestures?: boolean;
  readonly supportsWipers?: boolean;
  readonly wiperState?: 'off' | 'running' | 'parking';
  readonly parts: Readonly<Record<PartId, PartSnapshot>>;
}

export type ActionOutcome = 'completed' | 'already-at-target' | 'failed' | 'cancelled';

export interface VehicleActionResult {
  readonly action: VehicleAction;
  readonly outcome: ActionOutcome;
}

export interface VehicleSceneDriver {
  setPartOpen(partId: PartId, open: boolean): Promise<void>;
  setWindowOpenness?(partId: WindowId, openness: WindowOpenness, options?: { manual?: boolean }): Promise<void>;
  getWindowOpenness?(partId: WindowId): number;
  stopWindowMovement?(partId: WindowId): void;
  setWipersRunning?(running: boolean): Promise<void>;
  resetView(): void;
}

export interface ShowroomProps {
  onDriverChange(driver: VehicleSceneDriver | null): void;
  onPartClick(partId: PartId): void;
}

export interface VehicleController {
  getSnapshot(): VehicleSnapshot;
  subscribe(listener: () => void): () => void;
  attachScene(driver: VehicleSceneDriver | null): void;
  togglePart(partId: PartId): Promise<VehicleActionResult>;
  setWipersRunning?(running: boolean): Promise<ActionOutcome>;
  beginWindowMove?(partId: WindowId, direction: 'raise' | 'lower'): Promise<ActionOutcome>;
  stopWindow?(partId: WindowId): void;
  execute(
    actions: readonly VehicleAction[],
    options?: { signal?: AbortSignal; onResult?: (result: VehicleActionResult) => void },
  ): Promise<readonly VehicleActionResult[]>;
}

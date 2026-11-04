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

export type VehicleAction =
  | { kind: 'part'; partId: PartId; open: boolean }
  | { kind: 'group'; group: 'doors' | 'windows'; open: boolean }
  | { kind: 'engine'; running: boolean };

export interface PartSnapshot {
  readonly open: boolean;
  readonly targetOpen: boolean;
  readonly moving: boolean;
}

export interface VehicleSnapshot {
  readonly ready: boolean;
  readonly engineRunning: boolean;
  readonly parts: Readonly<Record<PartId, PartSnapshot>>;
}

export type ActionOutcome = 'completed' | 'already-at-target' | 'failed' | 'cancelled';

export interface VehicleActionResult {
  readonly action: VehicleAction;
  readonly outcome: ActionOutcome;
}

export interface VehicleSceneDriver {
  setPartOpen(partId: PartId, open: boolean): Promise<void>;
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
  execute(
    actions: readonly VehicleAction[],
    options?: { signal?: AbortSignal; onResult?: (result: VehicleActionResult) => void },
  ): Promise<readonly VehicleActionResult[]>;
}

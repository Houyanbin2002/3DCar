import type { PartId } from '../contracts/vehicle';

type PartDefinition = { node: string } & (
  | { axis: 'x' | 'z'; angle: number }
  | { travel: number }
);

// Node mapping and travel/angle calibration adapted from FormDrive's studioConfig.js.
export const MODEL_3_PARTS: Record<PartId, PartDefinition> = {
  frontLeftDoor: { node: 'door_lf_dummy', axis: 'z', angle: -1.08 },
  frontRightDoor: { node: 'door_rf_dummy', axis: 'z', angle: 1.08 },
  rearLeftDoor: { node: 'door_lr_dummy', axis: 'z', angle: -1.02 },
  rearRightDoor: { node: 'door_rr_dummy', axis: 'z', angle: 1.02 },
  frontLeftWindow: { node: 'door_lf_glass.0_0', travel: 0.31 },
  frontRightWindow: { node: 'door_rf_glass.0_0', travel: 0.31 },
  rearLeftWindow: { node: 'door_lr_glass.0_0', travel: 0.27 },
  rearRightWindow: { node: 'door_rr_glass.0_0', travel: 0.27 },
  frunk: { node: 'bonnet_dummy', axis: 'x', angle: 0.58 },
  trunk: { node: 'boot_dummy', axis: 'x', angle: -0.82 },
};

export const MODEL_3_URL = import.meta.env.BASE_URL + 'models/tesla-model-3-2018.glb';

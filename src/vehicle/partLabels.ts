import { WINDOW_IDS } from '../contracts/vehicle';
import type { PartId } from '../contracts/vehicle';

export const PART_LABELS: Record<PartId, string> = {
  frontLeftDoor: '左前门',
  frontRightDoor: '右前门',
  rearLeftDoor: '左后门',
  rearRightDoor: '右后门',
  frontLeftWindow: '左前车窗',
  frontRightWindow: '右前车窗',
  rearLeftWindow: '左后车窗',
  rearRightWindow: '右后车窗',
  frunk: '前备箱',
  trunk: '后备箱',
};

const windows = new Set<PartId>(WINDOW_IDS);

export function partVerb(id: PartId, open: boolean) {
  if (windows.has(id)) return open ? '降下' : '升起';
  return open ? '打开' : '关闭';
}

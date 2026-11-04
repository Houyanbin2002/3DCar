import {
  Box3, DoubleSide, Group, MathUtils, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Plane, Vector3,
} from 'three';
import type { Material, Object3D } from 'three';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';
import { PART_IDS, WINDOW_IDS } from '../contracts/vehicle';
import type { PartId, WindowId, WindowOpenness } from '../contracts/vehicle';
import { MODEL_3_PARTS } from './model3Parts';
import { bindWipers } from './wipers';

interface Motion {
  target: number;
  from: number;
  elapsed: number;
  duration: number;
  manual: boolean;
  resolve(): void;
  reject(error: Error): void;
}

interface BoundPart {
  id: PartId;
  progress: number;
  motion?: Motion;
  anchorParent: Object3D;
  anchor: Vector3;
  apply(progress: number): void;
  updateClipping?(): void;
}

function normalize(name: string) {
  return name.replace(/[^a-z0-9_-]/gi, '').toLowerCase();
}

function findPart(root: Object3D, id: PartId) {
  const matches: Object3D[] = [];
  const name = normalize(MODEL_3_PARTS[id].node);
  root.traverse((object) => {
    if (normalize(object.name) === name) matches.push(object);
  });
  if (matches.length !== 1) throw new Error('无法唯一绑定车辆部件 ' + id);
  return matches[0];
}

// Window parenting and local travel are adapted from FormDrive's VehicleModel.jsx.
function bindPart(id: PartId, node: Object3D): BoundPart {
  const bounds = new Box3().setFromObject(node);
  const center = bounds.getCenter(new Vector3());
  const config = MODEL_3_PARTS[id];
  if ('axis' in config) {
    const { axis, angle } = config;
    const initial = node.rotation[axis];
    return {
      id,
      progress: 0,
      anchorParent: node,
      anchor: node.worldToLocal(center),
      apply(progress) { node.rotation[axis] = initial + angle * progress; },
    };
  }

  const parent = node.parent;
  if (!parent) throw new Error('车窗缺少车门父节点 ' + id);
  const initial = node.position.clone();
  const worldPosition = node.getWorldPosition(new Vector3());
  const distance = bounds.max.y - bounds.min.y;
  const travel = parent.worldToLocal(worldPosition.add(new Vector3(0, -distance, 0))).sub(initial);
  const worldClip = new Plane(new Vector3(0, 1, 0), -(bounds.min.y + 0.003));
  const localClip = worldClip.clone().applyMatrix4(parent.matrixWorld.clone().invert());
  node.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      material.clippingPlanes = [worldClip];
      material.needsUpdate = true;
    }
  });
  return {
    id,
    progress: 0,
    anchorParent: parent,
    anchor: parent.worldToLocal(center),
    apply(progress) {
      node.position.copy(initial).addScaledVector(travel, progress);
      node.visible = progress < 1;
    },
    updateClipping() { worldClip.copy(localClip).applyMatrix4(parent.matrixWorld); },
  };
}

export function prepareTesla(source: Group) {
  const asset = source.clone(true);
  const originalBounds = new Box3().setFromObject(asset);
  const center = originalBounds.getCenter(new Vector3());
  const size = originalBounds.getSize(new Vector3());
  asset.position.sub(new Vector3(center.x, originalBounds.min.y, center.z));

  const root = new Group();
  root.scale.setScalar(5.65 / Math.max(size.x, size.z));
  root.rotation.y = Math.PI;
  root.add(asset);
  root.updateMatrixWorld(true);

  const nodes = new Map(PART_IDS.map((id) => [id, findPart(asset, id)]));
  const windowSet = new Set<PartId>(WINDOW_IDS);
  const owners = new Map<Object3D, PartId>();
  for (const [id, node] of nodes) {
    node.traverse((object) => {
      if (object instanceof Mesh) owners.set(object, id);
    });
  }

  const meshes: Mesh[] = [];
  const ownedMaterials = new Set<Material>();
  const paintMaterials = new Map<Material, Material>();
  const paintNames = ['primary', 'paint_black', 'putih_putih0_0', 'putih002_putih0_0'];
  asset.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    // Geometry is shared with the cached GLB. Build once without reordering its indices.
    if (!object.geometry.boundsTree) {
      object.geometry.boundsTree = new MeshBVH(object.geometry, { indirect: true });
    }
    object.raycast = acceleratedRaycast;
    meshes.push(object);
    const id = owners.get(object);
    const isWindow = id !== undefined && windowSet.has(id);
    function styleMaterial(original: Material) {
      if (isWindow) {
        const copy = original.clone();
        copy.transparent = true;
        copy.opacity = 0.38;
        copy.depthWrite = false;
        copy.side = DoubleSide;
        if (copy instanceof MeshStandardMaterial) {
          copy.color.set('#526572');
          copy.metalness = 0.05;
          copy.roughness = 0.12;
        }
        ownedMaterials.add(copy);
        return copy;
      }
      if (!(original instanceof MeshStandardMaterial)
        || !paintNames.some((name) => normalize(original.name).includes(name))) return original;

      const existing = paintMaterials.get(original);
      if (existing) return existing;
      const silver = new MeshPhysicalMaterial({
        name: original.name,
        color: '#9ea6af',
        metalness: 0.84,
        roughness: 0.19,
        clearcoat: 0.95,
        clearcoatRoughness: 0.12,
        map: original.map,
        normalMap: original.normalMap,
        normalScale: original.normalScale,
        aoMap: original.aoMap,
        side: original.side,
      });
      paintMaterials.set(original, silver);
      ownedMaterials.add(silver);
      return silver;
    }
    object.material = Array.isArray(object.material)
      ? object.material.map(styleMaterial)
      : styleMaterial(object.material);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    object.castShadow = !isWindow && !object.name.startsWith('dvor')
      && materials.some((material) => !material.transparent);
    object.receiveShadow = !isWindow;
  });

  const parts = new Map(Array.from(nodes, ([id, node]) => [id, bindPart(id, node)]));
  const wipers = bindWipers(asset);

  function animatePart(id: PartId, target: number, manual = false): Promise<void> {
    const part = parts.get(id);
    if (!part) return Promise.reject(new Error('未知部件 ' + id));
    if (part.motion) return Promise.reject(new Error('部件正在运动 ' + id));
    if (part.progress === target) return Promise.resolve();
    return new Promise((resolve, reject) => {
      part.motion = {
        target,
        from: part.progress,
        elapsed: 0,
        duration: 0.25 + 0.9 * Math.abs(target - part.progress),
        manual,
        resolve,
        reject,
      };
    });
  }

  function advance(delta: number) {
    let moved = wipers.advance(delta);
    let shadowChanged = false;
    for (const part of parts.values()) {
      const motion = part.motion;
      if (!motion) continue;
      moved = true;
      motion.elapsed += delta;
      const isWindow = windowSet.has(part.id);
      if (!isWindow) shadowChanged = true;
      const time = Math.min(motion.elapsed / motion.duration, 1);
      let next: number;
      let settled: boolean;
      if (isWindow && motion.manual) {
        const distance = 0.45 * (motion.elapsed - 0.12 * (1 - Math.exp(-motion.elapsed / 0.12)));
        const travel = Math.abs(motion.target - motion.from);
        next = motion.from + Math.sign(motion.target - motion.from) * Math.min(distance, travel);
        settled = distance >= travel;
      } else if (isWindow) {
        next = MathUtils.lerp(motion.from, motion.target, MathUtils.smootherstep(time, 0, 1));
        settled = time === 1;
      } else {
        next = MathUtils.damp(part.progress, motion.target, 10, delta);
        settled = Math.abs(next - motion.target) < 0.003;
      }
      part.progress = settled ? motion.target : next;
      part.apply(part.progress);
      if (settled) {
        part.motion = undefined;
        motion.resolve();
      }
    }
    if (moved) {
      root.updateMatrixWorld(true);
      parts.forEach((part) => part.updateClipping?.());
    }
    return { moved, shadowChanged };
  }

  function dispose() {
    wipers.dispose();
    for (const part of parts.values()) {
      part.motion?.reject(new Error('车模已卸载'));
      part.motion = undefined;
    }
    ownedMaterials.forEach((material) => material.dispose());
  }

  return {
    root,
    meshes,
    owners,
    parts,
    setPartOpen: (id: PartId, open: boolean) => animatePart(id, Number(open)),
    setWindowOpenness: (id: WindowId, openness: WindowOpenness, options?: { manual?: boolean }) => {
      if (!windowSet.has(id) || !Number.isFinite(openness) || openness < 0 || openness > 1) {
        return Promise.reject(new Error('无效的车窗目标位置'));
      }
      return animatePart(id, openness, options?.manual);
    },
    getWindowOpenness: (id: WindowId) => parts.get(id)?.progress ?? 0,
    stopWindowMovement: (id: WindowId) => {
      const part = parts.get(id);
      if (!part?.motion) return;
      const motion = part.motion;
      part.motion = undefined;
      motion.resolve();
    },
    setWipersRunning: wipers.setRunning,
    advance,
    dispose,
  };
}

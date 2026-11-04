import {
  Box3, Group, MathUtils, Mesh, MeshStandardMaterial, Vector3,
} from 'three';
import type { Material, Object3D } from 'three';
import { PART_IDS, WINDOW_IDS } from '../contracts/vehicle';
import type { PartId } from '../contracts/vehicle';
import { MODEL_3_PARTS } from './model3Parts';

interface Motion {
  target: number;
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

// Window travel and fade are adapted from FormDrive's VehicleModel.jsx.
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
  const distance = Math.max(config.travel, bounds.max.y - bounds.min.y + 0.08);
  const travel = parent.worldToLocal(worldPosition.add(new Vector3(0, -distance, 0))).sub(initial);
  const materials = new Map<Material, { opacity: number; transparent: boolean; depthWrite: boolean }>();
  node.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.set(material, {
        opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite,
      });
    }
  });
  return {
    id,
    progress: 0,
    anchorParent: parent,
    anchor: parent.worldToLocal(center),
    apply(progress) {
      node.position.copy(initial).addScaledVector(travel, progress);
      const mask = 1 - MathUtils.smootherstep(progress, 0.14, 0.68);
      node.visible = mask > 0.015;
      for (const [material, base] of materials) {
        material.opacity = base.opacity * mask;
        const transparent = mask < 0.995 || base.transparent;
        if (material.transparent !== transparent) {
          material.transparent = transparent;
          material.needsUpdate = true;
        }
        material.depthWrite = mask > 0.995 && base.depthWrite;
      }
    },
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
    meshes.push(object);
    const id = owners.get(object);
    const isWindow = id !== undefined && windowSet.has(id);
    function styleMaterial(original: Material) {
      if (isWindow) {
        const copy = original.clone();
        ownedMaterials.add(copy);
        return copy;
      }
      if (!(original instanceof MeshStandardMaterial)
        || !paintNames.some((name) => normalize(original.name).includes(name))) return original;

      const existing = paintMaterials.get(original);
      if (existing) return existing;
      const silver = original.clone();
      silver.color.set('#b4bcc8');
      silver.metalness = 0.64;
      silver.roughness = 0.24;
      silver.vertexColors = false;
      paintMaterials.set(original, silver);
      ownedMaterials.add(silver);
      return silver;
    }
    object.material = Array.isArray(object.material)
      ? object.material.map(styleMaterial)
      : styleMaterial(object.material);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    object.castShadow = !isWindow && materials.some((material) => !material.transparent);
    object.receiveShadow = !isWindow;
  });

  const parts = new Map(Array.from(nodes, ([id, node]) => [id, bindPart(id, node)]));

  function setPartOpen(id: PartId, open: boolean): Promise<void> {
    const part = parts.get(id);
    if (!part) return Promise.reject(new Error('未知部件 ' + id));
    if (part.motion) return Promise.reject(new Error('部件正在运动 ' + id));
    const target = Number(open);
    if (part.progress === target) return Promise.resolve();
    return new Promise((resolve, reject) => {
      part.motion = { target, resolve, reject };
    });
  }

  function advance(delta: number) {
    let moved = false;
    for (const part of parts.values()) {
      const motion = part.motion;
      if (!motion) continue;
      moved = true;
      const speed = windowSet.has(part.id) ? 8.5 : 10;
      const next = MathUtils.damp(part.progress, motion.target, speed, delta);
      const settled = Math.abs(next - motion.target) < 0.003;
      part.progress = settled ? motion.target : next;
      part.apply(part.progress);
      if (settled) {
        part.motion = undefined;
        motion.resolve();
      }
    }
    if (moved) root.updateMatrixWorld(true);
    return moved;
  }

  function dispose() {
    for (const part of parts.values()) {
      part.motion?.reject(new Error('车模已卸载'));
      part.motion = undefined;
    }
    ownedMaterials.forEach((material) => material.dispose());
  }

  return { root, meshes, owners, parts, setPartOpen, advance, dispose };
}

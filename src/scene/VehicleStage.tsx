import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import {
  Matrix4, Mesh, PerspectiveCamera, Raycaster, Vector2, Vector3,
} from 'three';
import type { Intersection, Material, Object3D } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { PartId, ShowroomProps } from '../contracts/vehicle';
import { PART_LABELS, partVerb } from '../vehicle/partLabels';
import { MODEL_3_URL } from './model3Parts';
import { prepareTesla } from './teslaModel';
import { StudioEnvironment } from './StudioEnvironment';

export const INITIAL_CAMERA: [number, number, number] = [7.3, 2.55, 6.6];

function visibleHit(hit: Intersection) {
  for (let node: Object3D | null = hit.object; node; node = node.parent) {
    if (!node.visible) return false;
  }
  if (hit.object instanceof Mesh) {
    const material: Material | undefined = Array.isArray(hit.object.material)
      ? hit.object.material[hit.face?.materialIndex ?? 0]
      : hit.object.material;
    if (material?.clippingPlanes?.some((plane) => plane.distanceToPoint(hit.point) < 0)) return false;
  }
  return true;
}

type StageProps = ShowroomProps & {
  buttons: RefObject<Map<PartId, HTMLButtonElement>>;
};

export function VehicleStage({ onDriverChange, onPartClick, buttons }: StageProps) {
  const asset = useLoader(GLTFLoader, MODEL_3_URL);
  const model = useMemo(() => prepareTesla(asset.scene), [asset.scene]);
  const { camera, gl, size } = useThree();
  const orbit = useRef<OrbitControls | null>(null);
  const reportPick = useEffectEvent(onPartClick);
  const reportDriver = useEffectEvent(onDriverChange);
  const pickRay = useMemo(() => {
    const ray = new Raycaster();
    ray.firstHitOnly = true;
    return ray;
  }, []);
  const markerRay = useMemo(() => {
    const ray = new Raycaster();
    ray.firstHitOnly = true;
    return ray;
  }, []);
  const screen = useMemo(() => new Vector2(), []);
  const point = useMemo(() => new Vector3(), []);
  const projected = useMemo(() => new Vector3(), []);
  const direction = useMemo(() => new Vector3(), []);
  const origin = useMemo(() => new Vector3(), []);
  const visibility = useRef(new Map<PartId, boolean>());
  const visibilityDirty = useRef(true);
  const lastVisibilityUpdate = useRef(-Infinity);
  const lastCameraMatrix = useMemo(() => new Matrix4(), []);
  const lastProjection = useMemo(() => new Matrix4(), []);

  useLayoutEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return;
    const offset = size.width >= 1000 ? 0.12 : size.width >= 720 ? 0.06 : 0;
    camera.setViewOffset(size.width, size.height, size.width * offset, 0, size.width, size.height);
  }, [camera, size.height, size.width]);

  useEffect(() => {
    const canvas = gl.domElement;
    const controls = new OrbitControls(camera, canvas);
    camera.position.set(...INITIAL_CAMERA);
    controls.target.set(0, 0.77, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.enablePan = false;
    controls.minDistance = 4.5;
    controls.maxDistance = 16;
    controls.minPolarAngle = Math.PI / 8;
    controls.maxPolarAngle = Math.PI / 2 - 0.055;
    controls.update();
    orbit.current = controls;

    let press: { id: number; x: number; y: number; dragged: boolean } | null = null;
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return;
      press = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
    };
    const move = (event: PointerEvent) => {
      if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) {
        press.dragged = true;
      }
    };
    const end = (event: PointerEvent) => {
      if (press?.id !== event.pointerId) return;
      move(event);
      const dragged = press.dragged;
      press = null;
      if (dragged || event.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) return;
      screen.set(
        (event.clientX - rect.left) / rect.width * 2 - 1,
        -(event.clientY - rect.top) / rect.height * 2 + 1,
      );
      camera.updateMatrixWorld();
      pickRay.setFromCamera(screen, camera);
      const hit = pickRay.intersectObjects(model.meshes, false).find(visibleHit);
      const id = hit && model.owners.get(hit.object);
      if (id) reportPick(id);
    };
    const cancel = () => { press = null; };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('lostpointercapture', cancel);
    return () => {
      orbit.current = null;
      controls.dispose();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('lostpointercapture', cancel);
    };
  }, [camera, gl, model, pickRay, screen]);

  useEffect(() => {
    const previous = gl.localClippingEnabled;
    gl.localClippingEnabled = true;
    return () => { gl.localClippingEnabled = previous; };
  }, [gl]);

  useEffect(() => {
    reportDriver({
      setPartOpen: model.setPartOpen,
      setWindowOpenness: model.setWindowOpenness,
      getWindowOpenness: model.getWindowOpenness,
      stopWindowMovement: model.stopWindowMovement,
      setWipersRunning: model.setWipersRunning,
      resetView: () => {
        const controls = orbit.current;
        if (!controls) return;
        controls.enableDamping = false;
        controls.update();
        camera.position.set(...INITIAL_CAMERA);
        controls.target.set(0, 0.77, 0);
        controls.update();
        controls.enableDamping = true;
      },
    });
    return () => {
      reportDriver(null);
      model.dispose();
    };
  }, [camera, model]);

  useFrame(({ clock }, delta) => {
    if (orbit.current) {
      orbit.current.dampingFactor = 1 - Math.exp(-6 * Math.min(delta, 0.25));
      orbit.current.update();
    }
    const motion = model.advance(delta);
    if (motion.shadowChanged) gl.shadowMap.needsUpdate = true;
    if (motion.moved) {
      visibilityDirty.current = true;
    }
    camera.updateMatrixWorld();
    camera.getWorldPosition(origin);
    const cameraChanged = camera.matrixWorld.elements.some(
      (value, index) => Math.abs(value - lastCameraMatrix.elements[index]) > 1e-8,
    ) || !camera.projectionMatrix.equals(lastProjection);
    if (cameraChanged) {
      visibilityDirty.current = true;
      lastCameraMatrix.copy(camera.matrixWorld);
      lastProjection.copy(camera.projectionMatrix);
    }
    const updateVisibility = visibilityDirty.current
      && clock.elapsedTime - lastVisibilityUpdate.current > 0.075;
    if (updateVisibility) {
      lastVisibilityUpdate.current = clock.elapsedTime;
      visibilityDirty.current = false;
    }

    for (const [id, part] of model.parts) {
      const button = buttons.current.get(id);
      if (!button) continue;
      point.copy(part.anchor).applyMatrix4(part.anchorParent.matrixWorld);
      projected.copy(point).project(camera);
      const inView = Math.abs(projected.x) < 0.98 && Math.abs(projected.y) < 0.98
        && projected.z > -1 && projected.z < 1;
      if (inView && (updateVisibility || !visibility.current.has(id))) {
        direction.copy(point).sub(origin);
        markerRay.far = Math.max(0, direction.length() - 0.12);
        markerRay.set(origin, direction.normalize());
        const hit = markerRay.intersectObjects(model.meshes, false).find(visibleHit);
        visibility.current.set(id, !hit || model.owners.get(hit.object) === id);
      }
      button.style.visibility = inView && visibility.current.get(id) ? 'visible' : 'hidden';
      if (!inView) continue;
      button.style.left = (projected.x * 0.5 + 0.5) * size.width + 'px';
      button.style.top = (0.5 - projected.y * 0.5) * size.height + 'px';
      const tooltip = partVerb(id, part.progress < 0.5) + PART_LABELS[id];
      if (button.dataset.tooltip !== tooltip) button.dataset.tooltip = tooltip;
    }
  });

  return (
    <>
      <StudioEnvironment />
      <primitive object={model.root} dispose={null} />
    </>
  );
}

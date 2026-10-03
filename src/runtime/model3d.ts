import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { Layer } from '../shared/types';
import { valueAt } from '../shared/animation';

const loader = new GLTFLoader();
const models = new Map<string, Promise<GLTF>>();
let renderer: THREE.WebGLRenderer | undefined;

function numberAt(layer: Layer, property: keyof Layer, frame: number, fps: number, fallback: number): number {
  const value = valueAt(layer, property, frame, fps);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export async function renderModel3d(layer: Layer, url: string, frame: number, fps: number): Promise<HTMLCanvasElement> {
  let cached = models.get(url);
  if (!cached) { cached = loader.loadAsync(url); models.set(url, cached); }
  const source = await cached;
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
  }
  const width = Math.ceil(layer.width);
  const height = Math.ceil(layer.height);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const model = cloneSkeleton(source.scene);
  const pivot = new THREE.Group();
  pivot.add(model);
  scene.add(pivot);
  const box = new THREE.Box3().setFromObject(model);
  if (!box.isEmpty()) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    pivot.scale.setScalar(2 * numberAt(layer, 'modelScale', frame, fps, 1) / Math.max(size.x, size.y, size.z, 0.001));
  }
  pivot.rotation.set(
    THREE.MathUtils.degToRad(numberAt(layer, 'modelPitch', frame, fps, 0)),
    THREE.MathUtils.degToRad(numberAt(layer, 'modelYaw', frame, fps, 0)),
    THREE.MathUtils.degToRad(numberAt(layer, 'modelRoll', frame, fps, 0)),
  );
  if (source.animations.length) {
    const mixer = new THREE.AnimationMixer(model);
    for (const clip of source.animations) mixer.clipAction(clip).play();
    mixer.setTime((frame - layer.startFrame) / fps);
  }
  const camera = new THREE.PerspectiveCamera(numberAt(layer, 'cameraFov', frame, fps, 45), width / height, 0.01, 1000);
  camera.position.set(0, 0, numberAt(layer, 'cameraDistance', frame, fps, 3));
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 1));
  const light = new THREE.DirectionalLight(0xffffff, numberAt(layer, 'lightIntensity', frame, fps, 2));
  light.position.set(3, 4, 5);
  scene.add(light);
  renderer.render(scene, camera);
  return renderer.domElement;
}

import type { EasingCurve, KeyframeValue, Layer, Scene } from './types';
import { evaluateExpression } from './expression';

const bezier = (first: number, second: number, t: number): number => {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
};

export function easedProgress(progress: number, curve?: EasingCurve): number {
  if (!curve) return progress;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    const middle = (low + high) / 2;
    if (bezier(curve[0], curve[2], middle) < progress) low = middle;
    else high = middle;
  }
  return bezier(curve[1], curve[3], (low + high) / 2);
}

function keyframedValueAt(layer: Layer, property: string, frame: number): KeyframeValue | boolean | undefined {
  const base = property.startsWith('params.')
    ? layer.params?.[property.slice(7)]
    : layer[property as keyof Layer];
  const keys = layer.keyframes[property];
  if (!keys?.length) return base as KeyframeValue | boolean | undefined;
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  if (frame <= sorted[0].frame) return sorted[0].value;
  if (frame >= sorted[sorted.length - 1].frame) return sorted[sorted.length - 1].value;
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const prev = sorted[i - 1];
    if (frame <= next.frame) {
      if (typeof prev.value !== 'number' || typeof next.value !== 'number') return prev.value;
      const ratio = (frame - prev.frame) / (next.frame - prev.frame);
      return prev.value + (next.value - prev.value) * easedProgress(ratio, prev.easing);
    }
  }
  return base as KeyframeValue | boolean | undefined;
}

export function valueAt(layer: Layer, property: string, frame: number, fps = 30): KeyframeValue | boolean | undefined {
  let base = keyframedValueAt(layer, property, frame);
  const expression = layer.expressions?.[property];
  if (!expression) return base;
  if (base === undefined) base = ({ blur: 0, brightness: 1, saturation: 1, volume: 1, modelScale: 1, modelYaw: 0, modelPitch: 0, modelRoll: 0, cameraDistance: 3, cameraFov: 45, lightIntensity: 2 } as Record<string, number>)[property];
  if (typeof base !== 'number') throw new Error(`Expression requires a numeric property: ${property}`);
  let seed = 2166136261;
  for (const character of layer.id) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  return evaluateExpression(expression, { frame, time: frame / fps, fps, base, seed });
}

export function retimeLayer(layer: Layer, sceneDuration: number, mode: 'move' | 'start' | 'end', delta: number): void {
  if (mode === 'start') {
    layer.startFrame = Math.max(0, Math.min(layer.endFrame - 1, layer.startFrame + delta));
    return;
  }
  if (mode === 'end') {
    layer.endFrame = Math.max(layer.startFrame + 1, Math.min(sceneDuration, layer.endFrame + delta));
    return;
  }
  const frames = Object.values(layer.keyframes).flatMap(keys => keys.map(key => key.frame));
  const minimum = Math.max(-layer.startFrame, frames.length ? -Math.min(...frames) : -sceneDuration);
  const maximum = Math.min(sceneDuration - layer.endFrame, frames.length ? sceneDuration - 1 - Math.max(...frames) : sceneDuration);
  const shift = Math.max(minimum, Math.min(maximum, delta));
  layer.startFrame += shift;
  layer.endFrame += shift;
  for (const keys of Object.values(layer.keyframes)) for (const key of keys) key.frame += shift;
}

export function totalFrames(scenes: Scene[]): number {
  return scenes.reduce((total, scene) => total + clipBounds(scene).outFrame - clipBounds(scene).inFrame, 0);
}

export function clipBounds(scene: Scene): { inFrame: number; outFrame: number } {
  return scene.clip || { inFrame: 0, outFrame: scene.durationFrames };
}

export function sceneStartFrame(scenes: Scene[], sceneIndex: number): number {
  return scenes.slice(0, sceneIndex).reduce((total, scene) => total + clipBounds(scene).outFrame - clipBounds(scene).inFrame, 0);
}

export function globalFrameFor(scenes: Scene[], sceneIndex: number, localFrame: number): number {
  const clip = clipBounds(scenes[sceneIndex]);
  return sceneStartFrame(scenes, sceneIndex) + Math.max(0, Math.min(clip.outFrame - clip.inFrame - 1, localFrame - clip.inFrame));
}

export function sceneAtFrame(scenes: Scene[], globalFrame: number): { sceneIndex: number; frame: number } {
  let remaining = globalFrame;
  for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex++) {
    const clip = clipBounds(scenes[sceneIndex]);
    const length = clip.outFrame - clip.inFrame;
    if (remaining < length) return { sceneIndex, frame: clip.inFrame + remaining };
    remaining -= length;
  }
  const last = scenes.at(-1);
  return { sceneIndex: Math.max(0, scenes.length - 1), frame: last ? clipBounds(last).outFrame - 1 : 0 };
}

export function makeLayer(type: Layer['type'], durationFrames: number, width: number, height: number): Layer {
  return {
    id: crypto.randomUUID(), name: `New ${type}`, type, startFrame: 0, endFrame: durationFrames,
    x: width / 2, y: height / 2, width: type === 'shape' ? 240 : 400,
    height: type === 'shape' ? 160 : 120, scaleX: 1, scaleY: 1, rotation: 0,
    opacity: 1, visible: true, keyframes: {},
    ...(type === 'text' ? { text: 'New title', fontSize: 64, color: '#ffffff', fontFamily: 'Arial' } : {}),
    ...(type === 'shape' ? { shape: 'rect' as const, color: '#5da9ff' } : {}),
    ...(type === 'image' ? { asset: 'assets/image.png' } : {}),
    ...(type === 'svg' ? { asset: 'assets/graphic.svg' } : {}),
    ...(type === 'video' ? { asset: 'assets/video.mp4' } : {}),
    ...(type === 'audio' ? { asset: 'assets/audio.wav', volume: 1 } : {}),
    ...(type === 'model3d' ? { asset: 'assets/model.glb', modelScale: 1, modelYaw: 0, modelPitch: 0, modelRoll: 0, cameraDistance: 3, cameraFov: 45, lightIntensity: 2 } : {}),
    ...(type === 'custom' ? { script: 'scripts/effect.mjs', renderer: '2d' as const, params: {} } : {}),
  };
}

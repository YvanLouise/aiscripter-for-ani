import type { AudioClip, AudioTrack, Scene } from './types';
import { clipBounds, sceneAtFrame, totalFrames } from './animation';

export function duplicateScene(scene: Scene, id: () => string): Scene {
  return { ...structuredClone(scene), id: id(), name: `${scene.name} 副本`, layers: scene.layers.map(layer => ({ ...structuredClone(layer), id: id() })) };
}

export function splitScene(scenes: Scene[], globalFrame: number, id: () => string): Scene[] {
  if (globalFrame <= 0 || globalFrame >= totalFrames(scenes)) return scenes;
  const { sceneIndex, frame } = sceneAtFrame(scenes, globalFrame);
  const source = scenes[sceneIndex];
  const bounds = clipBounds(source);
  if (frame === bounds.inFrame) return scenes;
  const left: Scene = { ...source, clip: { inFrame: bounds.inFrame, outFrame: frame } };
  const right = duplicateScene(source, id);
  right.clip = { inFrame: frame, outFrame: bounds.outFrame };
  return [...scenes.slice(0, sceneIndex), left, right, ...scenes.slice(sceneIndex + 1)];
}

export function reorderScene(scenes: Scene[], from: number, to: number): Scene[] {
  if (from === to || from < 0 || to < 0 || from >= scenes.length || to >= scenes.length) return scenes;
  const result = [...scenes];
  result.splice(to, 0, result.splice(from, 1)[0]);
  return result;
}

export function trimScene(scene: Scene, edge: 'start' | 'end', delta: number): Scene {
  const bounds = clipBounds(scene);
  const clip = edge === 'start'
    ? { inFrame: Math.max(0, Math.min(bounds.outFrame - 1, bounds.inFrame + delta)), outFrame: bounds.outFrame }
    : { inFrame: bounds.inFrame, outFrame: Math.max(bounds.inFrame + 1, Math.min(scene.durationFrames, bounds.outFrame + delta)) };
  return { ...scene, clip };
}

export function trimAudioClip(clip: AudioClip, edge: 'start' | 'end', delta: number): AudioClip {
  if (edge === 'start') {
    const shift = Math.max(-Math.min(clip.startFrame, clip.sourceInFrame), Math.min(clip.durationFrames - 1, delta));
    return { ...clip, startFrame: clip.startFrame + shift, sourceInFrame: clip.sourceInFrame + shift, durationFrames: clip.durationFrames - shift };
  }
  return { ...clip, durationFrames: Math.max(1, clip.durationFrames + delta) };
}

export function audioFits(track: AudioTrack, clip: AudioClip): boolean {
  return clip.startFrame >= 0 && clip.sourceInFrame >= 0 && clip.durationFrames > 0
    && track.clips.every(other => other.id === clip.id || clip.startFrame + clip.durationFrames <= other.startFrame || other.startFrame + other.durationFrames <= clip.startFrame);
}

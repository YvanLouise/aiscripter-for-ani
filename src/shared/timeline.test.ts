import { describe, expect, it } from 'vitest';
import type { AudioClip, AudioTrack, Scene } from './types';
import { clipBounds, globalFrameFor, sceneAtFrame, totalFrames } from './animation';
import { audioFits, duplicateScene, reorderScene, splitScene, trimAudioClip, trimScene } from './timeline';

const scenes: Scene[] = [
  { id: 'a', name: 'A', durationFrames: 150, layers: [{ id: 'layer-a', name: 'A', type: 'shape', startFrame: 0, endFrame: 150, x: 0, y: 0, width: 10, height: 10, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, visible: true, keyframes: { x: [{ frame: 140, value: 5 }] } }] },
  { id: 'b', name: 'B', durationFrames: 150, layers: [] },
];

describe('continuous sequence', () => {
  it('maps v1 scenes to all 300 frames and preserves local frames after trimming', () => {
    expect(totalFrames(scenes)).toBe(300);
    const trimmed = [trimScene(scenes[0], 'start', 20), trimScene(scenes[1], 'end', -30)];
    expect(totalFrames(trimmed)).toBe(250);
    expect(sceneAtFrame(trimmed, 0)).toEqual({ sceneIndex: 0, frame: 20 });
    expect(sceneAtFrame(trimmed, 129)).toEqual({ sceneIndex: 0, frame: 149 });
    expect(sceneAtFrame(trimmed, 130)).toEqual({ sceneIndex: 1, frame: 0 });
    expect(globalFrameFor(trimmed, 1, 0)).toBe(130);
    expect(clipBounds(trimScene(trimmed[0], 'start', -20))).toEqual({ inFrame: 0, outFrame: 150 });
    expect(trimmed[0].layers[0].keyframes.x[0].frame).toBe(140);
  });
  it('splits into independent scenes while preserving source frames and assets', () => {
    let index = 0;
    const result = splitScene(scenes, 75, () => `new-${++index}`);
    expect(result).toHaveLength(3);
    expect(result[0].clip).toEqual({ inFrame: 0, outFrame: 75 });
    expect(result[1].clip).toEqual({ inFrame: 75, outFrame: 150 });
    expect(result[1].id).not.toBe(result[0].id);
    expect(result[1].layers[0].id).not.toBe(result[0].layers[0].id);
    expect(sceneAtFrame(result, 75)).toEqual({ sceneIndex: 1, frame: 75 });
    expect(totalFrames(reorderScene(result, 1, 2))).toBe(300);
    expect(duplicateScene(result[0], () => `other-${++index}`).layers[0].id).not.toBe('layer-a');
  });
  it('keeps global audio positions and prevents overlap within one track', () => {
    const clip: AudioClip = { id: 'music', asset: 'assets/music.wav', startFrame: 20, sourceInFrame: 0, durationFrames: 200, volume: 1 };
    const track: AudioTrack = { id: 'track', name: 'Music', clips: [clip, { ...clip, id: 'next', startFrame: 230, durationFrames: 20 }] };
    expect(audioFits(track, { ...clip, startFrame: 30 })).toBe(true);
    expect(audioFits(track, { ...clip, startFrame: 40, durationFrames: 200 })).toBe(false);
    expect(trimAudioClip(clip, 'start', 10)).toMatchObject({ startFrame: 30, sourceInFrame: 10, durationFrames: 190 });
    expect(trimAudioClip(trimAudioClip(clip, 'start', 10), 'start', -10)).toEqual(clip);
  });
});

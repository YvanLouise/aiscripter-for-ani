import { describe, expect, it } from 'vitest';
import { easedProgress, retimeLayer, sceneAtFrame, totalFrames, valueAt } from './animation';
import type { Layer, Scene } from './types';

const layer: Layer = {
  id: 'title', name: 'Title', type: 'text', startFrame: 0, endFrame: 90,
  x: 100, y: 200, width: 200, height: 50, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1,
  visible: true, keyframes: {
    x: [{ frame: 0, value: 0 }, { frame: 20, value: 100 }],
    'params.label': [{ frame: 0, value: 'A' }, { frame: 20, value: 'B' }],
  }, params: { label: 'Initial' },
};

describe('animation frame evaluation', () => {
  it('interpolates numeric values and holds string values', () => {
    expect(valueAt(layer, 'x', 10)).toBe(50);
    expect(valueAt(layer, 'x', 25)).toBe(100);
    expect(valueAt(layer, 'params.label', 10)).toBe('A');
    expect(valueAt(layer, 'params.label', 20)).toBe('B');
  });
  it('maps global export frames to scene-local frames', () => {
    const scenes = [{ durationFrames: 150 }, { durationFrames: 150 }] as Scene[];
    expect(totalFrames(scenes)).toBe(300);
    expect(sceneAtFrame(scenes, 149)).toEqual({ sceneIndex: 0, frame: 149 });
    expect(sceneAtFrame(scenes, 150)).toEqual({ sceneIndex: 1, frame: 0 });
  });
  it('evaluates cubic easing while preserving exact keyframe values', () => {
    const eased = structuredClone(layer);
    eased.keyframes.x[0].easing = [0.42, 0, 1, 1];
    expect(valueAt(eased, 'x', 0)).toBe(0);
    expect(Number(valueAt(eased, 'x', 10))).toBeLessThan(50);
    expect(valueAt(eased, 'x', 20)).toBe(100);
    expect(easedProgress(0.5, [0, 0, 1, 1])).toBeCloseTo(0.5, 6);
  });
  it('moves a layer and its keyframes together, then trims its range', () => {
    const moving = structuredClone(layer);
    moving.startFrame = 5;
    moving.endFrame = 50;
    retimeLayer(moving, 90, 'move', 10);
    expect([moving.startFrame, moving.endFrame]).toEqual([15, 60]);
    expect(moving.keyframes.x.map(key => key.frame)).toEqual([10, 30]);
    retimeLayer(moving, 90, 'start', 100);
    expect(moving.startFrame).toBe(59);
    retimeLayer(moving, 90, 'end', -100);
    expect(moving.endFrame).toBe(60);
    retimeLayer(moving, 90, 'move', 100);
    expect(moving.endFrame).toBe(90);
    expect(moving.keyframes.x.every(key => key.frame < 90)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { applyAnimationPreset } from './presets';
import { valueAt } from './animation';
import type { Layer } from './types';

const layer: Layer = { id: 'item', name: 'Item', type: 'shape', startFrame: 10, endFrame: 40,
  x: 100, y: 100, width: 100, height: 100, scaleX: 1, scaleY: 1, rotation: 0,
  opacity: 0.8, visible: true, keyframes: {}, shape: 'rect', color: '#ffffff' };

describe('animation presets', () => {
  it('uses layer-local bounds and exact endpoint values', () => {
    const result = structuredClone(layer);
    applyAnimationPreset(result, 'fadeIn', 30);
    expect(valueAt(result, 'opacity', 10)).toBe(0);
    expect(valueAt(result, 'opacity', 25)).toBe(0.8);
    applyAnimationPreset(result, 'fadeOut', 30);
    expect(valueAt(result, 'opacity', 39)).toBe(0);
  });
  it('does not place keys outside a short layer', () => {
    const result = { ...structuredClone(layer), endFrame: 12 };
    applyAnimationPreset(result, 'popIn', 30);
    expect(result.keyframes.scaleX.map(key => key.frame)).toEqual([10, 11]);
    expect(result.keyframes.scaleY.map(key => key.frame)).toEqual([10, 11]);
  });
  it('keeps loop keys unique and inside layer bounds', () => {
    const result = structuredClone(layer);
    applyAnimationPreset(result, 'breathe', 30);
    expect(result.keyframes.scaleX[0].frame).toBe(10);
    expect(result.keyframes.scaleX.at(-1)?.frame).toBe(39);
    expect(new Set(result.keyframes.scaleX.map(key => key.frame)).size).toBe(result.keyframes.scaleX.length);
    expect(result.keyframes.scaleY.map(key => key.frame)).toEqual(result.keyframes.scaleX.map(key => key.frame));
  });
});

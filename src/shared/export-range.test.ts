import { describe, expect, it } from 'vitest';
import { resolveExportRange } from './export-range';
import type { Scene } from './types';

const scenes: Scene[] = [
  { id: 'opening', name: 'Opening', durationFrames: 150, clip: { inFrame: 30, outFrame: 120 }, layers: [] },
  { id: 'ending', name: 'Ending', durationFrames: 100, clip: { inFrame: 10, outFrame: 80 }, layers: [] },
];
const output = { width: 1920, height: 1080, fps: 30 };

describe('export ranges on trimmed scenes', () => {
  it('uses visible frames for full and scene exports', () => {
    expect(resolveExportRange(scenes, 0, output)).toEqual({ start: 0, end: 160 });
    expect(resolveExportRange(scenes, 1, { ...output, scope: 'scene' })).toEqual({ start: 90, end: 160 });
  });
  it('rejects ranges outside the composed video', () => {
    expect(resolveExportRange(scenes, 0, { ...output, scope: 'range', startFrame: 89, endFrame: 91 })).toEqual({ start: 89, end: 91 });
    expect(() => resolveExportRange(scenes, 0, { ...output, scope: 'range', startFrame: 90, endFrame: 90 })).toThrow();
    expect(() => resolveExportRange(scenes, 0, { ...output, scope: 'range', startFrame: 0, endFrame: 161 })).toThrow();
  });
});

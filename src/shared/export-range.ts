import { clipBounds, sceneStartFrame, totalFrames } from './animation';
import type { ExportOptions, Scene } from './types';

export function resolveExportRange(scenes: Scene[], sceneIndex: number, options: ExportOptions): { start: number; end: number } {
  const total = totalFrames(scenes);
  let start = 0;
  let end = total;
  if (options.scope === 'scene') {
    if (!scenes[sceneIndex]) throw new Error('Scene is unavailable');
    start = sceneStartFrame(scenes, sceneIndex);
    const bounds = clipBounds(scenes[sceneIndex]);
    end = start + bounds.outFrame - bounds.inFrame;
  } else if (options.scope === 'range') {
    start = options.startFrame ?? 0;
    end = options.endFrame ?? total;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > total) {
    throw new Error(`Invalid export range: ${start}..${end} of ${total} frames`);
  }
  return { start, end };
}

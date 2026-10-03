import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Layer } from '../shared/types';
import { volumeFilter } from './audio-volume';

const layer: Layer = {
  id: 'audio', name: 'Music', type: 'audio', startFrame: 0, endFrame: 30,
  x: 0, y: 0, width: 1, height: 1, scaleX: 1, scaleY: 1, rotation: 0,
  opacity: 1, visible: true, asset: 'assets/music.wav', volume: 1,
  keyframes: { volume: [{ frame: 0, value: 0.2 }, { frame: 29, value: 0.8, easing: [0.42, 0, 0.58, 1] }] },
};

describe('audio volume export', () => {
  it('uses a constant filter when no automation exists', () => {
    expect(volumeFilter({ ...layer, keyframes: {}, volume: 0.4 }, 0, 30, 30)).toBe('volume=0.4');
  });

  it('changes encoded audio gain across keyframes', () => {
    const ffmpeg = createRequire(import.meta.url)('@ffmpeg-installer/ffmpeg').path as string;
    const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=1', '-af', volumeFilter(layer, 0, 30, 30), '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'], { maxBuffer: 1024 * 1024 });
    expect(result.status, result.stderr.toString()).toBe(0);
    const rms = (start: number, end: number) => {
      let power = 0;
      for (let sample = start; sample < end; sample++) power += result.stdout.readFloatLE(sample * 4) ** 2;
      return Math.sqrt(power / (end - start));
    };
    expect(rms(38000, 43000)).toBeGreaterThan(rms(3000, 8000) * 2);
  });
});

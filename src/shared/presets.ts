import type { Layer } from './types';

export type AnimationPreset = 'fadeIn' | 'fadeOut' | 'slideIn' | 'slideOut' | 'scaleIn' | 'scaleOut' | 'popIn' | 'blurIn' | 'blurOut' | 'rotateIn' | 'float' | 'pulse' | 'shake' | 'rotate' | 'breathe';

export function applyAnimationPreset(layer: Layer, preset: AnimationPreset, fps: number): void {
  const length = Math.min(Math.max(1, Math.round(fps * 0.5)), layer.endFrame - layer.startFrame - 1);
  if (length < 1) return;
  const start = layer.startFrame;
  const end = layer.endFrame - 1;
  const incoming = [0, 0, 0.58, 1] as const;
  const outgoing = [0.42, 0, 1, 1] as const;
  if (preset === 'fadeIn') layer.keyframes.opacity = [
    { frame: start, value: 0, easing: [...incoming] },
    { frame: start + length, value: layer.opacity },
  ];
  else if (preset === 'fadeOut') layer.keyframes.opacity = [
    { frame: end - length, value: layer.opacity, easing: [...outgoing] },
    { frame: end, value: 0 },
  ];
  else if (preset === 'slideIn') layer.keyframes.x = [
    { frame: start, value: layer.x - Math.max(80, layer.width * 0.6), easing: [...incoming] },
    { frame: start + length, value: layer.x },
  ];
  else if (preset === 'slideOut') layer.keyframes.x = [
    { frame: end - length, value: layer.x, easing: [...outgoing] },
    { frame: end, value: layer.x + Math.max(80, layer.width * 0.6) },
  ];
  else if (preset === 'blurIn' || preset === 'blurOut') layer.keyframes.blur = preset === 'blurIn' ? [
    { frame: start, value: 16, easing: [...incoming] }, { frame: start + length, value: 0 },
  ] : [{ frame: end - length, value: 0, easing: [...outgoing] }, { frame: end, value: 16 }];
  else if (preset === 'rotateIn') layer.keyframes.rotation = [
    { frame: start, value: layer.rotation - 90, easing: [...incoming] }, { frame: start + length, value: layer.rotation },
  ];
  else if (preset === 'scaleIn' || preset === 'scaleOut' || preset === 'popIn') {
    for (const property of ['scaleX', 'scaleY'] as const) layer.keyframes[property] = preset === 'scaleOut' ? [
      { frame: end - length, value: layer[property], easing: [...outgoing] },
      { frame: end, value: layer[property] * 0.1 },
    ] : [
        { frame: start, value: layer[property] * (preset === 'popIn' ? 0.2 : 0.1), easing: [...incoming] },
        { frame: start + length, value: layer[property] },
    ];
  } else {
    const cycle = Math.max(2, Math.min(end - start, Math.round(fps * 2)));
    const half = Math.max(1, Math.floor(cycle / 2));
    const property = preset === 'float' ? 'y' : preset === 'shake' ? 'x' : preset === 'rotate' ? 'rotation' : 'scaleX';
    const baseline = layer[property];
    const amplitude = preset === 'float' ? -24 : preset === 'shake' ? 12 : preset === 'rotate' ? 360 : preset === 'pulse' ? baseline * 0.12 : baseline * 0.05;
    const keys = [{ frame: start, value: baseline }];
    for (let cursor = start; cursor < end; cursor += cycle) {
      const middle = Math.min(end, cursor + half);
      const finish = Math.min(end, cursor + cycle);
      if (middle > keys.at(-1)!.frame) keys.push({ frame: middle, value: preset === 'rotate' ? baseline + (middle - start) / cycle * amplitude : baseline + amplitude });
      if (finish > keys.at(-1)!.frame) keys.push({ frame: finish, value: preset === 'rotate' ? baseline + (finish - start) / cycle * amplitude : baseline });
    }
    layer.keyframes[property] = keys;
    if (preset === 'pulse' || preset === 'breathe') layer.keyframes.scaleY = keys.map(key => ({ ...key, value: baseline ? key.value / baseline * layer.scaleY : layer.scaleY }));
  }
}

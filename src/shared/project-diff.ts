import type { Layer, LoadedProject, Scene } from './types';

function changed(a: unknown, b: unknown): boolean { return JSON.stringify(a) !== JSON.stringify(b); }

function valueLabel(value: unknown): string {
  if (value === undefined) return '未设置';
  if (typeof value === 'string') return value.length > 32 ? `${value.slice(0, 32)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '复合内容';
}

function layerChanges(before: Layer, after: Layer, prefix: string): string[] {
  const fields = Object.keys({ ...before, ...after }) as (keyof Layer)[];
  return fields.filter(field => changed(before[field], after[field])).map(field =>
    `${prefix}：${field} ${valueLabel(before[field])} → ${valueLabel(after[field])}`);
}

function sceneChanges(before: Scene, after: Scene): string[] {
  const prefix = `场景 ${after.name}`;
  const lines: string[] = [];
  for (const field of ['name', 'durationFrames', 'clip'] as const) {
    if (changed(before[field], after[field])) lines.push(`${prefix}：${field} ${valueLabel(before[field])} → ${valueLabel(after[field])}`);
  }
  if (!before.program || !after.program) {
    if (changed(before.program, after.program)) lines.push(`${prefix}：程序配置已变化`);
  } else {
    for (const field of ['entry', 'renderer', 'seed', 'params'] as const) if (changed(before.program[field], after.program[field])) lines.push(`${prefix}：program.${field} ${valueLabel(before.program[field])} → ${valueLabel(after.program[field])}`);
    for (const scope of ['parameters', 'objects', 'instances'] as const) {
      const old = before.program.edits?.[scope] || {}, next = after.program.edits?.[scope] || {};
      for (const id of new Set([...Object.keys(old), ...Object.keys(next)])) if (changed(old[id as keyof typeof old], next[id as keyof typeof next])) lines.push(`${prefix}：人工覆盖 ${scope}/${id} 已变化`);
    }
  }
  const oldLayers = new Map(before.layers.map(layer => [layer.id, layer]));
  const newLayers = new Map(after.layers.map(layer => [layer.id, layer]));
  for (const layer of before.layers) if (!newLayers.has(layer.id)) lines.push(`${prefix}：删除图层 ${layer.name}`);
  for (const layer of after.layers) {
    const old = oldLayers.get(layer.id);
    if (!old) lines.push(`${prefix}：新增图层 ${layer.name}`);
    else lines.push(...layerChanges(old, layer, `${prefix} / ${layer.name}`));
  }
  if (changed(before.layers.map(layer => layer.id), after.layers.map(layer => layer.id))) lines.push(`${prefix}：图层顺序已变化`);
  return lines;
}

export function diffProjects(local: LoadedProject, disk: LoadedProject): string[] {
  const lines: string[] = [];
  for (const field of ['formatVersion', 'sdkVersion', 'name', 'width', 'height', 'fps', 'audioTracks'] as const) {
    if (changed(local.manifest[field], disk.manifest[field])) lines.push(`工程 ${field} ${valueLabel(local.manifest[field])} → ${valueLabel(disk.manifest[field])}`);
  }
  const oldScenes = new Map(local.scenes.map(scene => [scene.id, scene]));
  const newScenes = new Map(disk.scenes.map(scene => [scene.id, scene]));
  for (const scene of local.scenes) if (!newScenes.has(scene.id)) lines.push(`删除场景 ${scene.name}`);
  for (const scene of disk.scenes) {
    const old = oldScenes.get(scene.id);
    if (!old) lines.push(`新增场景 ${scene.name}`);
    else lines.push(...sceneChanges(old, scene));
  }
  if (changed(local.scenes.map(scene => scene.id), disk.scenes.map(scene => scene.id))) lines.push('场景顺序已变化');
  return lines.length ? lines.slice(0, 200) : ['工程结构没有变化；差异可能仅在资源或脚本文件中。'];
}

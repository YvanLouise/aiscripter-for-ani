import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { checkProject, createProject, loadProject, readScript, realProjectFile, revisionOf, safeRelative, writeProject, writeScript } from './project';
import { valueAt } from '../shared/animation';

const sample = path.join(process.cwd(), 'examples', 'solar-system');

describe('project contract', () => {
  it('loads the 300-frame sample and its stable IDs', async () => {
    const project = await loadProject(sample);
    expect(project.scenes.map(scene => scene.id)).toEqual(['introduction', 'orbit']);
    expect(project.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0)).toBe(300);
    expect(project.scenes[0].layers.some(layer => layer.renderer === 'webgl2')).toBe(true);
    expect(project.scenes[0].layers.some(layer => layer.type === 'shape')).toBe(true);
  });
  it('keeps the sample orbit smooth and closed', async () => {
    const project = await loadProject(sample);
    const earth = project.scenes[1].layers.find(layer => layer.id === 'orbit-earth')!;
    const position = (frame: number) => [Number(valueAt(earth, 'x', frame, 30)), Number(valueAt(earth, 'y', frame, 30))];
    const start = position(0);
    const quarter = position(37);
    const half = position(75);
    const threeQuarters = position(112);
    const end = position(149);
    expect(start[0]).toBeGreaterThan(half[0]);
    expect(quarter[1]).toBeGreaterThan(start[1]);
    expect(threeQuarters[1]).toBeLessThan(start[1]);
    expect(Math.hypot(end[0] - start[0], end[1] - start[1])).toBeLessThan(25);
  });
  it('rejects path traversal and project-external paths', () => {
    expect(() => safeRelative(sample, '../secret.txt')).toThrow();
    expect(() => safeRelative(sample, 'C:/secret.txt')).toThrow();
    expect(() => safeRelative(sample, 'assets/../../secret.txt')).toThrow();
  });
  it('detects external changes and preserves edits through save and reload', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-test-'));
    const target = path.join(base, 'project');
    try {
      await fs.cp(sample, target, { recursive: true });
      const loaded = await loadProject(target);
      loaded.scenes[0].layers.find(layer => layer.id === 'intro-title')!.x = 1030;
      const saved = await writeProject(target, loaded);
      expect((await loadProject(target)).scenes[0].layers.find(layer => layer.id === 'intro-title')!.x).toBe(1030);
      expect(saved.revision).toBe(await revisionOf(target));
      await fs.writeFile(await realProjectFile(target, 'assets/palette.json'), '{"updated":true}');
      expect(await revisionOf(target)).not.toBe(saved.revision);
      const reloaded = await loadProject(target);
      expect(reloaded.scenes[0].layers.find(layer => layer.id === 'intro-title')!.x).toBe(1030);
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  it('upgrades v1 on save, backs up original JSON, and round-trips clip and audio metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-upgrade-'));
    try {
      await fs.cp(sample, root, { recursive: true });
      const project = await loadProject(root);
      expect(project.manifest.formatVersion).toBe(1);
      project.scenes[0].clip = { inFrame: 20, outFrame: 140 };
      project.manifest.audioTracks = [{ id: 'music', name: 'Music', clips: [{ id: 'clip', asset: 'assets/music.wav', startFrame: 50, sourceInFrame: 10, durationFrames: 100, volume: 0.5 }] }];
      const saved = await writeProject(root, project);
      expect(saved.manifest.formatVersion).toBe(2);
      expect(saved.scenes[0].clip).toEqual({ inFrame: 20, outFrame: 140 });
      expect(saved.manifest.audioTracks?.[0].clips[0].startFrame).toBe(50);
      const backup = (await fs.readdir(path.join(root, '.aiscripter-backups')))[0];
      const oldManifest = JSON.parse(await fs.readFile(path.join(root, '.aiscripter-backups', backup, 'project.json'), 'utf8'));
      expect(oldManifest.formatVersion).toBe(1);
      expect(await fs.readFile(path.join(root, '.aiscripter-backups', backup, 'scenes', 'introduction.json'), 'utf8')).toContain('intro-title');
      expect((await checkProject(saved)).warnings.some(message => message.includes('assets/music.wav'))).toBe(true);
      saved.manifest.audioTracks![0].clips.push({ id: 'overlap', asset: 'assets/music.wav', startFrame: 100, sourceInFrame: 0, durationFrames: 30, volume: 1 });
      await expect(writeProject(root, saved)).rejects.toThrow('Overlapping audio clips');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('rejects an invalid scene instead of opening partial state', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-invalid-'));
    const target = path.join(base, 'project');
    try {
      await fs.cp(sample, target, { recursive: true });
      const file = path.join(target, 'scenes', 'orbit.json');
      const scene = JSON.parse(await fs.readFile(file, 'utf8'));
      scene.durationFrames = -1;
      await fs.writeFile(file, JSON.stringify(scene));
      await expect(loadProject(target)).rejects.toThrow('Invalid scenes/orbit.json');
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  it('rejects invalid edits before changing files on disk', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-save-'));
    const target = path.join(base, 'project');
    try {
      await fs.cp(sample, target, { recursive: true });
      const loaded = await loadProject(target);
      const original = loaded.revision;
      loaded.scenes[0].layers[0].endFrame = loaded.scenes[0].durationFrames + 1;
      await expect(writeProject(target, loaded)).rejects.toThrow('Invalid layer time');
      expect(await revisionOf(target)).toBe(original);
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  it('removes a deleted scene file when saving', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-delete-'));
    const target = path.join(base, 'project');
    try {
      await fs.cp(sample, target, { recursive: true });
      const loaded = await loadProject(target);
      loaded.scenes.pop();
      const saved = await writeProject(target, loaded);
      expect(saved.scenes.map(scene => scene.id)).toEqual(['introduction']);
      await expect(fs.access(path.join(target, 'scenes', 'orbit.json'))).rejects.toThrow();
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  it('creates a complete project only in an empty folder', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-new-'));
    try {
      const created = await createProject(root);
      expect(created.manifest.formatVersion).toBe(2);
      expect(created.manifest.audioTracks).toEqual([]);
      expect(created.scenes).toHaveLength(1);
      expect((await fs.stat(path.join(root, 'scripts'))).isDirectory()).toBe(true);
      expect((await fs.stat(path.join(root, 'assets'))).isDirectory()).toBe(true);
      await expect(createProject(root)).rejects.toThrow('empty folder');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('reports missing assets without rejecting an editable project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-check-'));
    try {
      await fs.cp(sample, root, { recursive: true });
      const project = await loadProject(root);
      project.scenes[0].layers.find(layer => layer.type === 'image')!.asset = 'assets/missing.png';
      const result = await checkProject(project);
      expect(result.ok).toBe(true);
      expect(result.warnings.some(warning => warning.includes('assets/missing.png'))).toBe(true);
      expect(result.missingAssets).toContain('assets/missing.png');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('explains unsupported project versions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-version-'));
    try {
      await fs.cp(sample, root, { recursive: true });
      const file = path.join(root, 'project.json');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      manifest.formatVersion = 4;
      await fs.writeFile(file, JSON.stringify(manifest));
      await expect(loadProject(root)).rejects.toThrow('supports versions 1, 2 and 3');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('round-trips easing and rejects invalid control points before saving', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-easing-'));
    try {
      await fs.cp(sample, root, { recursive: true });
      const project = await loadProject(root);
      const title = project.scenes[0].layers.find(layer => layer.id === 'intro-title')!;
      title.keyframes.opacity[0].easing = [0.42, 0, 0.58, 1];
      const saved = await writeProject(root, project);
      expect((await loadProject(root)).scenes[0].layers.find(layer => layer.id === 'intro-title')!.keyframes.opacity[0].easing).toEqual([0.42, 0, 0.58, 1]);
      title.keyframes.opacity[0].easing = [-1, 0, 0.58, 1];
      await expect(writeProject(root, project)).rejects.toThrow('Invalid scene');
      expect(await revisionOf(root)).toBe(saved.revision);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('edits project scripts while rejecting paths outside scripts/', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-script-'));
    try {
      await fs.cp(sample, root, { recursive: true });
      await writeScript(root, 'scripts/effect.mjs', 'export function render() {}\n');
      expect(await readScript(root, 'scripts/effect.mjs')).toContain('render');
      await expect(writeScript(root, '../escape.mjs', '')).rejects.toThrow();
      await expect(writeScript(root, 'assets/not-a-script.mjs', '')).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('round-trips expressions and rejects executable syntax before writing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-expression-'));
    try {
      await fs.cp(sample, root, { recursive: true });
      const project = await loadProject(root);
      const title = project.scenes[0].layers.find(layer => layer.id === 'intro-title')!;
      title.expressions = { x: 'base + 10 * sin(time)' };
      const saved = await writeProject(root, project);
      expect((await loadProject(root)).scenes[0].layers.find(layer => layer.id === 'intro-title')?.expressions?.x).toBe('base + 10 * sin(time)');
      title.expressions.x = 'globalThis.x';
      await expect(writeProject(root, project)).rejects.toThrow('Invalid expression');
      expect(await revisionOf(root)).toBe(saved.revision);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('validates project-local JSON data bindings', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-binding-'));
    try {
      await fs.cp(path.join(process.cwd(), 'examples', 'transparent-layer'), root, { recursive: true });
      const project = await loadProject(root);
      const circle = project.scenes[0].layers[0];
      expect(circle.bindings?.color).toEqual({ asset: 'assets/data.json', path: 'theme.circleColor' });
      circle.bindings!.color.path = '__proto__.constructor';
      await expect(writeProject(root, project)).rejects.toThrow('Invalid data path');
      circle.bindings!.color.path = 'theme.circleColor';
      circle.bindings!.color.asset = '../outside.json';
      await expect(writeProject(root, project)).rejects.toThrow('Invalid project path');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

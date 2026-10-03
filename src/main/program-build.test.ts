import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildPrograms } from './program-build';
import { loadProject, writeProject } from './project';
import { enablePrograms } from '../shared/program';
import { duplicateScene, splitScene } from '../shared/timeline';
import { sceneAtFrame } from '../shared/animation';

const sample = path.join(process.cwd(), 'examples/program-scenes');
describe('v3 programs', () => {
  it('type checks and bundles local components and the fixed SDK without disk writes', async () => {
    const project = await loadProject(sample);
    const built = await buildPrograms(project);
    expect(built.diagnostics).toEqual([]);
    expect(built.programs.program.path).toMatch(/^scripts\/__compiled_/);
    expect(Object.values(built.sources)[0]).toContain('components/card.ts');
    const copy = duplicateScene(project.scenes[1], () => 'copy');
    project.scenes.push(copy);
    expect((await buildPrograms(project)).programs.copy.hash).toBe(built.programs.program.hash);
  });
  it('locates type errors and keeps independent scenes buildable', async () => {
    const project = await loadProject(sample);
    project.scenes.push({ id: 'bad', name: 'Bad', durationFrames: 30, layers: [], program: { entry: 'scripts/bad.ts', renderer: '2d', seed: 1 } });
    project.sources!['scripts/bad.ts'] = 'const count: number = "wrong"; export default count;';
    const built = await buildPrograms(project);
    expect(built.programs.program.path).toBeTruthy();
    expect(built.programs.bad.path).toBeUndefined();
    expect(built.diagnostics[0]).toMatchObject({ path: 'scripts/bad.ts', line: 1 });
  });
  it('rejects system, network, traversal and computed imports', async () => {
    for (const source of ['import fs from "node:fs"; export default fs;', 'import "https://example.com/code.js";', 'import "../../outside.ts";', 'const name = "./other.ts"; import(name);']) {
      const project = await loadProject(sample);
      project.sources!['scripts/studio.ts'] = source;
      const built = await buildPrograms(project);
      expect(built.diagnostics.length).toBeGreaterThan(0);
      expect(built.programs.program.path).toBeUndefined();
    }
  });
  it('upgrades only explicitly and backs up the complete old project before saving v3', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ani-v3-upgrade-'));
    try {
      await fs.cp(path.join(process.cwd(), 'examples/sequence-v2'), root, { recursive: true });
      const project = await loadProject(root);
      project.scenes[1].program = { entry: 'scripts/main.ts', renderer: '2d', seed: 42 };
      project.sources = { 'scripts/main.ts': 'export default () => ({ evaluate() { return []; } });' };
      await expect(writeProject(root, project)).rejects.toThrow();
      enablePrograms(project);
      const saved = await writeProject(root, project);
      expect(saved.manifest.formatVersion).toBe(3);
      expect(saved.scenes[1].program).toEqual(project.scenes[1].program);
      const directory = (await fs.readdir(path.join(root, '.aiscripter-backups')))[0];
      expect(JSON.parse(await fs.readFile(path.join(root, '.aiscripter-backups', directory, 'project.json'), 'utf8')).formatVersion).toBe(2);
      expect(await fs.readFile(path.join(root, '.aiscripter-backups', directory, 'assets/tone.wav'))).toEqual(await fs.readFile(path.join(root, 'assets/tone.wav')));
      saved.manifest.sdkVersion = '2.0.0' as '1.0.0';
      await expect(writeProject(root, saved)).rejects.toThrow('Invalid project');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('preserves explicit seeds and local time through split and copy', async () => {
    const project = await loadProject(sample);
    let id = 0;
    const scenes = splitScene(project.scenes, 225, () => `new-${++id}`);
    expect(scenes[1].program?.seed).toBe(scenes[2].program?.seed);
    expect(sceneAtFrame(scenes, 225)).toEqual({ sceneIndex: 2, frame: 75 });
    expect(scenes[1].program?.entry).toBe(scenes[2].program?.entry);
    expect(scenes[1].layers[0].id).not.toBe(scenes[2].layers[0].id);
  });
});

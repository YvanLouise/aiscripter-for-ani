import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkProject, loadProject, writeProject } from './project';

describe('persisted program edits', () => {
  it('round trips objects, parameters, instances and keys and rejects ambiguous frames', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-edits-'));
    try {
      await fs.cp(path.join(process.cwd(), 'examples/program-scenes'), root, { recursive: true });
      const project = await loadProject(root), scene = project.scenes.find(scene => scene.program)!;
      project.manifest.sdkVersion = '1.0.0';
      expect((await checkProject(project)).ok).toBe(true);
      scene.program!.edits = { objects: { title: { type: 'text', properties: { x: { value: 42, mode: 'offset', keyframes: [{ frame: 0, value: 42 }, { frame: 10, value: 60, easing: 'smooth' }] } } } }, parameters: { title: { value: 'Human', locked: true } }, instances: { 'card-0': { parameters: { value: { value: 88 } } } } };
      expect((await checkProject(project)).ok).toBe(false);
      project.manifest.sdkVersion = '1.1.0';
      expect((await checkProject(project)).ok).toBe(true);
      await writeProject(root, project, project.revision);
      expect((await loadProject(root)).scenes.find(scene => scene.program)!.program!.edits).toEqual(scene.program!.edits);
      scene.program!.edits.objects!.title.properties.x.keyframes![1].frame = 0;
      expect((await checkProject(project)).ok).toBe(false);
      scene.program!.edits.objects!.title.properties.x.keyframes![1].frame = scene.durationFrames;
      expect((await checkProject(project)).ok).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

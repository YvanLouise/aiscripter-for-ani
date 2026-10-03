import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AiProjectService, applyChanges, importAsset, offlineService } from './ai-service';
import { loadProject, revisionOf } from './project';
import type { AiSession } from '../shared/ai-service';

const sample = path.join(process.cwd(), 'examples', 'solar-system');
describe('AI project transactions', () => {
  it('preserves human program edits on AI updates and protects their locks', async () => {
    const project = await loadProject(path.join(process.cwd(), 'examples/program-scenes'));
    const scene = project.scenes.find(scene => scene.program)!;
    scene.program!.edits = { objects: { title: { type: 'text', properties: { x: { mode: 'offset', value: 42 } } } }, parameters: { title: { value: 'Human title' } } };
    const { edits: _edits, ...config } = scene.program!;
    const updated = applyChanges(project, [{ kind: 'update_scene', sceneId: scene.id, patch: { program: { ...config, params: { title: 'AI title' } } } }]);
    expect(updated.scenes.find(value => value.id === scene.id)!.program!.edits).toEqual(scene.program!.edits);
    expect(() => applyChanges(project, [{ kind: 'update_scene', sceneId: scene.id, patch: { program: { ...config, edits: {} } } }])).toThrow('HUMAN_OVERRIDES');
    expect(() => applyChanges(project, [{ kind: 'remove_scene', sceneId: scene.id }])).toThrow('HUMAN_OVERRIDES');
    scene.program!.edits!.objects!.title.locked = true;
    expect(() => applyChanges(project, [{ kind: 'write_script', path: 'scripts/studio.ts', source: '' }])).toThrow('LOCKED');
    expect(() => applyChanges(project, [{ kind: 'remove_scene', sceneId: scene.id }])).toThrow('LOCKED');
    expect(() => applyChanges(project, [{ kind: 'update_scene', sceneId: scene.id, patch: { durationFrames: 50 } }])).toThrow('LOCKED');
    expect(() => applyChanges(project, [{ kind: 'update_project', patch: { width: 1280 } }])).toThrow('LOCKED');
  });
  it('preserves human properties, stages scripts without disk mutation and rejects stale drafts', async () => {
    const project = await loadProject(sample);
    project.scenes[0].layers.find(layer => layer.id === 'intro-title')!.x = 1234;
    let state: AiSession = { mode: 'editor', diskRevision: project.revision, draftRevision: 'draft:1', dirty: true, project };
    const service = new AiProjectService(async () => state, async (next) => state = { ...state, project: next, draftRevision: 'draft:2' });
    const before = await revisionOf(sample);
    const stage = await service.stage(state.draftRevision, state.diskRevision, [{ kind: 'write_script', path: 'scripts/new-background.mjs', source: 'export function render() {}' }]);
    expect(await revisionOf(sample)).toBe(before);
    const committed = await service.commit(stage.id);
    expect(committed.project.scenes[0].layers.find(layer => layer.id === 'intro-title')!.x).toBe(1234);
    expect(committed.project.sources?.['scripts/new-background.mjs']).toContain('render');
    const stale = await service.stage(state.draftRevision, state.diskRevision, [{ kind: 'update_project', patch: { name: 'AI name' } }]);
    state = { ...state, draftRevision: 'draft:3' };
    await expect(service.commit(stale.id)).rejects.toThrow('REVISION_CONFLICT');
  });
  it('rejects locked edits, malformed scenes and script traversal', async () => {
    const project = await loadProject(sample);
    project.scenes[0].layers[0].locked = true;
    expect(() => applyChanges(project, [{ kind: 'update_layer', sceneId: project.scenes[0].id, layerId: project.scenes[0].layers[0].id, patch: { locked: false } }])).toThrow('LOCKED');
    expect(() => applyChanges(project, [{ kind: 'write_script', path: 'scripts/../../outside.mjs', source: '' }])).toThrow();
    expect(() => applyChanges(project, [{ kind: 'write_script', path: 'scripts/.hidden.mjs', source: '' }])).toThrow();
    const state: AiSession = { mode: 'editor', diskRevision: project.revision, draftRevision: 'd1', dirty: false, project };
    const service = new AiProjectService(async () => state, async () => state);
    await expect(service.stage('d1', project.revision, [{ kind: 'update_scene', sceneId: project.scenes[0].id, patch: { durationFrames: 1 } }])).rejects.toThrow('INVALID_CHANGES');
  });
  it('persists an offline multi-file edit and detects intervening disk edits', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ani-ai-service-'));
    try {
      await fs.cp(sample, root, { recursive: true });
      const { read, service, undo } = offlineService(root);
      let state = await read();
      const stage = await service.stage(state.draftRevision, state.diskRevision, [
        { kind: 'update_layer', sceneId: 'introduction', layerId: 'intro-title', patch: { text: 'Offline title' } },
        { kind: 'write_script', path: 'scripts/dependency.mjs', source: 'export const value = 42;' },
      ]);
      state = await service.commit(stage.id);
      expect(state.project.scenes[0].layers.find(layer => layer.id === 'intro-title')!.text).toBe('Offline title');
      expect(state.project.sources?.['scripts/dependency.mjs']).toContain('42');
      const undone = await undo(state.undoId!, state.draftRevision, state.diskRevision);
      expect(undone.project.scenes[0].layers.find(layer => layer.id === 'intro-title')!.text).not.toBe('Offline title');
      state = await undo(undone.undoId!, undone.draftRevision, undone.diskRevision);
      expect(state.project.scenes[0].layers.find(layer => layer.id === 'intro-title')!.text).toBe('Offline title');
      const stale = await service.stage(state.draftRevision, state.diskRevision, [{ kind: 'update_project', patch: { name: 'Wrong name' } }]);
      await fs.writeFile(path.join(root, 'assets', 'new.txt'), 'External');
      await expect(service.commit(stale.id)).rejects.toThrow('REVISION_CONFLICT');
      const revision = await revisionOf(root);
      const imported = await importAsset(root, revision, 'assets/imported.txt', Buffer.from('Asset bytes').toString('base64'));
      expect(imported).not.toBe(revision);
      await expect(importAsset(root, imported, 'assets/imported.txt', 'YQ==')).rejects.toThrow('already exists');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

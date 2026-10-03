import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AiChange, AiSession, AiStage } from '../shared/ai-service';
import { enablePrograms } from '../shared/program';
import type { Layer, LoadedProject, Scene } from '../shared/types';
import { checkProject, loadProject, realProjectFile, revisionOf, safeRelative, validateSources, writeProject } from './project';
import { diffProjects } from '../shared/project-diff';
import { persistFiles } from './transactions';

export async function importAsset(root: string, expectedRevision: string, relative: string, base64: string): Promise<string> {
  if (typeof relative !== 'string' || !/^assets\/[A-Za-z0-9_./-]+\.(png|jpg|jpeg|webp|svg|json|txt|md|wav|mp3|ogg|m4a|aac|flac|mp4|webm|glb|gltf)$/i.test(relative) || relative.split('/').some(part => part.startsWith('.'))) throw new Error('Import requires a new file under assets/');
  const target = safeRelative(root, relative);
  if (typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Invalid base64 asset');
  const data = Buffer.from(base64, 'base64');
  if (!data.length || data.length > 8 * 1024 * 1024) throw new Error('Asset must be 1 byte to 8 MB');
  await persistFiles(root, { [relative]: data }, async () => {
    if (await revisionOf(root) !== expectedRevision) throw new Error('REVISION_CONFLICT: disk changed');
    if (await fs.access(target).then(() => true, () => false)) throw new Error('Asset already exists; choose a new name');
  });
  return revisionOf(root);
}

const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'id']);
function programLocked(scene: Scene): boolean {
  const edits = scene.program?.edits;
  return Object.values(edits?.objects || {}).some(object => object.locked || Object.values(object.properties).some(property => property.locked)) ||
    Object.values(edits?.parameters || {}).some(property => property.locked) || Object.values(edits?.instances || {}).some(instance => Object.values(instance.parameters).some(property => property.locked));
}
function patch(target: object, changes: Record<string, unknown> | undefined, allowed?: string[]): void {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('A patch object is required');
  for (const key of Object.keys(changes)) {
    if (forbidden.has(key) || (allowed && !allowed.includes(key))) throw new Error(`Unsupported patch field: ${key}`);
  }
  Object.assign(target, structuredClone(changes));
}

export function applyChanges(current: LoadedProject, changes: AiChange[]): LoadedProject {
  if (!changes.length || changes.length > 100) throw new Error('Provide 1 to 100 changes');
  const next = structuredClone(current);
  delete next.resourcePrefix;
  for (let change of changes) {
    const scene = next.scenes.find(value => value.id === change.sceneId);
    const layer = scene?.layers.find(value => value.id === change.layerId);
    switch (change.kind) {
      case 'update_layer':
      case 'remove_layer':
        if (!scene || !layer) throw new Error('Layer ID not found');
        if (layer.locked) throw new Error(`LOCKED: ${layer.id}`);
        if (change.kind === 'update_layer') patch(layer, change.patch);
        else scene.layers = scene.layers.filter(value => value.id !== layer.id);
        break;
      case 'add_layer':
        if (!scene) throw new Error('Scene ID not found');
        scene.layers.push(structuredClone(change.value) as Layer);
        break;
      case 'update_scene':
        if (!scene) throw new Error('Scene ID not found');
        if (change.patch && Object.hasOwn(change.patch, 'program')) {
          const program = change.patch.program as Scene['program'];
          if (scene.program?.edits) {
            if (!program || (program.edits !== undefined && JSON.stringify(program.edits) !== JSON.stringify(scene.program.edits))) throw new Error('HUMAN_OVERRIDES: AI cannot replace or delete human edits');
            change = { ...change, patch: { ...change.patch, program: { ...program, edits: structuredClone(scene.program.edits) } } };
          } else if (program?.edits) throw new Error('HUMAN_OVERRIDES: edits are managed by the editor');
          if (programLocked(scene)) throw new Error(`LOCKED: program ${scene.id}`);
        }
        if (programLocked(scene) && change.patch?.durationFrames !== undefined && change.patch.durationFrames !== scene.durationFrames) throw new Error(`LOCKED: program duration ${scene.id}`);
        patch(scene, change.patch, ['name', 'durationFrames', 'clip', 'program']);
        break;
      case 'remove_scene':
        if (!scene) throw new Error('Scene ID not found');
        if (scene.layers.some(value => value.locked) || programLocked(scene)) throw new Error(`LOCKED: scene ${scene.id}`);
        if (scene.program?.edits && Object.values(scene.program.edits).some(scope => Object.keys(scope || {}).length)) throw new Error('HUMAN_OVERRIDES: remove this edited scene in the editor');
        next.scenes = next.scenes.filter(value => value.id !== scene.id);
        break;
      case 'add_scene': next.scenes.push(structuredClone(change.value) as Scene); break;
      case 'reorder_scenes': {
        const order = change.order;
        if (!order || order.length !== next.scenes.length || new Set(order).size !== order.length || order.some(id => !next.scenes.some(value => value.id === id))) throw new Error('Order must contain every scene ID exactly once');
        next.scenes = order.map(id => next.scenes.find(value => value.id === id)!);
        break;
      }
      case 'update_project':
        if (next.scenes.some(programLocked) && ['width', 'height', 'fps'].some(field => change.patch && Object.hasOwn(change.patch, field) && change.patch[field] !== next.manifest[field as 'width' | 'height' | 'fps'])) throw new Error('LOCKED: project geometry or timing may affect a locked program');
        patch(next.manifest, change.patch, ['name', 'width', 'height', 'fps', 'audioTracks']); break;
      case 'enable_programs': enablePrograms(next); break;
      case 'write_script':
        if (!change.path || typeof change.source !== 'string') throw new Error('Script path and source are required');
        safeRelative(next.root, change.path);
        // Shared dependencies can affect any locked custom layer, even indirectly.
        if (next.scenes.some(value => programLocked(value) || value.layers.some(item => item.locked && item.type === 'custom'))) throw new Error('LOCKED: script edits may affect a locked program object or custom layer');
        (next.sources ||= {})[change.path] = change.source;
        validateSources(next.root, next.sources, next.manifest.formatVersion);
        break;
      default: throw new Error('Unsupported change kind');
    }
  }
  next.manifest.scenes = next.scenes.map(value => ({ id: value.id, file: `scenes/${value.id}.json` }));
  return next;
}

export class AiProjectService {
  private stages = new Map<string, { public: AiStage; next: LoadedProject; expires: number }>();
  constructor(private readonly read: () => Promise<AiSession>, private readonly apply: (next: LoadedProject, expected: AiStage) => Promise<AiSession>) {}

  async stage(expectedDraftRevision: string, expectedDiskRevision: string, changes: AiChange[]): Promise<AiStage> {
    const session = await this.read();
    this.assertRevision(session, expectedDraftRevision, expectedDiskRevision);
    const next = applyChanges(session.project, changes);
    const check = await checkProject(next);
    if (!check.ok) throw new Error(`INVALID_CHANGES: ${check.errors.join('; ')}`);
    const summary = diffProjects(session.project, next);
    for (const relative of Object.keys(next.sources || {})) if (next.sources?.[relative] !== session.project.sources?.[relative]) summary.push(`Script: ${relative}`);
    const staged: AiStage = { id: randomUUID(), expectedDraftRevision, expectedDiskRevision, summary, check };
    for (const [id, entry] of this.stages) if (entry.expires < Date.now()) this.stages.delete(id);
    if (this.stages.size >= 32) throw new Error('Too many pending stages; commit or discard previous stages');
    this.stages.set(staged.id, { public: staged, next, expires: Date.now() + 10 * 60 * 1000 });
    return staged;
  }

  async commit(id: string): Promise<AiSession> {
    const entry = this.stages.get(id);
    if (!entry || entry.expires < Date.now()) throw new Error('STAGE_EXPIRED: stage again');
    const session = await this.read();
    this.assertRevision(session, entry.public.expectedDraftRevision, entry.public.expectedDiskRevision);
    const result = await this.apply(entry.next, entry.public);
    this.stages.delete(id);
    return result;
  }

  discard(id: string): void { this.stages.delete(id); }
  private assertRevision(session: AiSession, draft: string, disk: string): void {
    if (session.draftRevision !== draft || session.diskRevision !== disk || session.project.revision !== disk) throw new Error('REVISION_CONFLICT: draft or disk changed; inspect and stage again');
  }
}

export function offlineService(root: string): { read: () => Promise<AiSession>; service: AiProjectService; undo: (id: string, draft: string, disk: string) => Promise<AiSession> } {
  const read = async (): Promise<AiSession> => {
    const project = await loadProject(root);
    return { mode: 'offline', diskRevision: project.revision, draftRevision: `disk:${project.revision}`, dirty: false, project };
  };
  const save = async (next: LoadedProject, revision: string): Promise<AiSession> => {
    const before = await loadProject(root);
    if (before.revision !== revision) throw new Error('REVISION_CONFLICT: disk changed');
    const id = randomUUID();
    await writeProject(root, next, revision, { id, project: before });
    return { ...await read(), undoId: id };
  };
  return { read, service: new AiProjectService(read, async (next, expected) => {
    if (await revisionOf(root) !== expected.expectedDiskRevision) throw new Error('REVISION_CONFLICT: disk changed');
    return save(next, expected.expectedDiskRevision);
  }), undo: async (id, draft, disk) => {
    const current = await read();
    if (current.draftRevision !== draft || current.diskRevision !== disk) throw new Error('REVISION_CONFLICT: inspect again');
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid undo ID');
    const before = JSON.parse(await fs.readFile(await realProjectFile(root, `.aiscripter/offline-undo/${id}.json`), 'utf8')) as LoadedProject;
    return save({ ...before, root }, disk);
  } };
}

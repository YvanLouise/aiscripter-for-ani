import Ajv2020 from 'ajv/dist/2020';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LoadedProject, ProjectCheck, ProjectManifest, Scene } from '../shared/types';
import manifestSchema from '../../schema/project.schema.json';
import manifestV1Schema from '../../schema/project-v1.schema.json';
import sceneSchema from '../../schema/scene.schema.json';
import manifestV3Schema from '../../schema/project-v3.schema.json';
import sceneV3Schema from '../../schema/scene-v3.schema.json';
import { savedManifest } from '../shared/program';
import { validateExpression } from '../shared/expression';
import { totalFrames } from '../shared/animation';
import { persistFiles, recoverProject, type FileContent } from './transactions';

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
const validManifest = ajv.compile<ProjectManifest>(manifestSchema);
const validManifestV1 = ajv.compile<ProjectManifest>(manifestV1Schema);
const validScene = ajv.compile<Scene>(sceneSchema);
const validManifestV3 = ajv.compile<ProjectManifest>(manifestV3Schema);
const validSceneV3 = ajv.compile<Scene>(sceneV3Schema);
const manifestValidator = (version: number) => version === 1 ? validManifestV1 : version === 3 ? validManifestV3 : validManifest;

export function safeRelative(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid project path: ${relative}`);
  }
  const resolved = path.resolve(root, ...relative.split('/'));
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path escapes project: ${relative}`);
  return resolved;
}

export async function realProjectFile(root: string, relative: string): Promise<string> {
  const full = safeRelative(root, relative);
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(full);
  const rel = path.relative(realRoot, realFile);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Symlink escapes project');
  return realFile;
}

function scriptPath(root: string, relative: string, version = 3): string {
  const pattern = version === 3 ? /^(scripts|components)\/[A-Za-z0-9_./-]+\.(ts|mjs)$/ : /^scripts\/[A-Za-z0-9_./-]+\.mjs$/;
  if (!pattern.test(relative) || relative.split('/').some(part => part.startsWith('.'))) throw new Error('Source must be a visible project module in scripts/ or components/ (.ts requires v3)');
  return safeRelative(root, relative);
}

export async function readScript(root: string, relative: string): Promise<string> {
  scriptPath(root, relative);
  return fs.readFile(await realProjectFile(root, relative), 'utf8');
}

export async function writeScript(root: string, relative: string, source: string): Promise<void> {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 1024 * 1024) throw new Error('Script exceeds the 1 MB limit');
  const full = scriptPath(root, relative);
  const realRoot = await fs.realpath(root);
  const realParent = await fs.realpath(path.dirname(full));
  const rel = path.relative(realRoot, realParent);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Script directory escapes project');
  const temporary = `${full}.${process.pid}.tmp`;
  await fs.writeFile(temporary, source, 'utf8');
  await fs.rename(temporary, full);
}

async function walk(root: string, directory = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relative = path.posix.join(directory.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) results.push(...await walk(root, relative));
    else if (entry.isFile()) results.push(relative);
  }
  return results.sort();
}

export async function revisionOf(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const relative of await walk(root)) {
    hash.update(relative);
    hash.update(await fs.readFile(path.join(root, relative)));
  }
  return hash.digest('hex');
}

export async function loadProject(root: string): Promise<LoadedProject> {
  await recoverProject(root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8')) as ProjectManifest;
  if (![1, 2, 3].includes(manifest.formatVersion)) throw new Error(`Unsupported project format version: ${String(manifest.formatVersion)}. This editor supports versions 1, 2 and 3.`);
  const validate = manifestValidator(manifest.formatVersion);
  if (!validate(manifest)) throw new Error(`Invalid project.json: ${ajv.errorsText(validate.errors)}`);
  validateAudioTracks(root, manifest);
  const scenes: Scene[] = [];
  const ids = new Set<string>();
  for (const reference of manifest.scenes) {
    if (ids.has(reference.id)) throw new Error(`Duplicate scene ID: ${reference.id}`);
    ids.add(reference.id);
    const scene = JSON.parse(await fs.readFile(await realProjectFile(root, reference.file), 'utf8')) as Scene;
    if (manifest.formatVersion === 1 && scene.clip) throw new Error(`Invalid ${reference.file}: v1 scenes cannot have clip ranges`);
    if (scene.id !== reference.id) throw new Error(`Scene ID mismatch: ${reference.file}`);
    try { validateScene(root, scene, manifest); }
    catch (error) { throw new Error(`Invalid ${reference.file}: ${String(error)}`); }
    scenes.push(scene);
  }
  const sources: Record<string, string> = {};
  for (const relative of await walk(root)) {
    if ((relative.startsWith('scripts/') && relative.endsWith('.mjs')) || (manifest.formatVersion === 3 && /^(scripts|components)\/.*\.(ts|mjs)$/.test(relative))) {
      const file = await realProjectFile(root, relative);
      if ((await fs.stat(file)).size > 1024 * 1024) throw new Error(`Script exceeds 1 MB: ${relative}`);
      sources[relative] = await fs.readFile(file, 'utf8');
    }
  }
  validateSources(root, sources, manifest.formatVersion);
  return { manifest, scenes, root, revision: await revisionOf(root), sources };
}

export function validateSources(root: string, sources: Record<string, string> = {}, version = 3): void {
  let size = 0;
  for (const [relative, source] of Object.entries(sources)) {
    scriptPath(root, relative, version);
    if (typeof source !== 'string' || Buffer.byteLength(source) > 1024 * 1024) throw new Error(`Invalid or oversized script: ${relative}`);
    size += Buffer.byteLength(source);
  }
  if (size > 8 * 1024 * 1024) throw new Error('Project scripts exceed 8 MB');
}

export async function createProject(root: string): Promise<LoadedProject> {
  const entries = await fs.readdir(root);
  if (entries.length) throw new Error('Choose an empty folder for a new project');
  const scene: Scene = { id: 'scene-1', name: 'Scene 1', durationFrames: 150, layers: [] };
  const project: LoadedProject = { root, revision: '', scenes: [scene], manifest: {
    formatVersion: 2, id: randomUUID(), name: path.basename(root), width: 1920, height: 1080, fps: 30,
    scenes: [{ id: scene.id, file: 'scenes/scene-1.json' }],
    audioTracks: [],
  } };
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.mkdir(path.join(root, 'assets'));
  return writeProject(root, project);
}

export async function checkProject(project: LoadedProject): Promise<ProjectCheck> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const missingAssets = new Set<string>();
  const manifest = savedManifest(project);
  const validate = manifestValidator(manifest.formatVersion);
  if (!validate(manifest)) errors.push(`Invalid project: ${ajv.errorsText(validate.errors)}`);
  try { validateSources(project.root, project.sources, manifest.formatVersion); } catch (error) { errors.push(String(error)); }
  try { validateAudioTracks(project.root, manifest); } catch (error) { errors.push(String(error)); }
  if (new Set(project.scenes.map(scene => scene.id)).size !== project.scenes.length) errors.push('Duplicate scene ID');
  for (const scene of project.scenes) {
    try { validateScene(project.root, scene, manifest); } catch (error) { errors.push(`${scene.name}: ${String(error)}`); }
    if (scene.program && !Object.hasOwn(project.sources || {}, scene.program.entry)) errors.push(`${scene.name}: missing program entry ${scene.program.entry}`);
    for (const layer of scene.layers) {
      for (const relative of [layer.asset, layer.mask, layer.script, ...Object.values(layer.bindings || {}).map(binding => binding.asset)].filter((value): value is string => Boolean(value))) {
        try { if (!Object.hasOwn(project.sources || {}, relative)) await realProjectFile(project.root, relative); }
        catch (error) {
          warnings.push(`${scene.name} / ${layer.name}: ${relative} (${String(error)})`);
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relative.startsWith('assets/')) missingAssets.add(relative);
        }
      }
    }
  }
  for (const track of manifest.audioTracks || []) for (const clip of track.clips) {
    if (clip.startFrame + clip.durationFrames > totalFrames(project.scenes)) warnings.push(`${track.name}: ${clip.id} extends beyond video end and will be cut on export`);
    try { await realProjectFile(project.root, clip.asset); }
    catch (error) {
      warnings.push(`${track.name}: ${clip.asset} (${String(error)})`);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && clip.asset.startsWith('assets/')) missingAssets.add(clip.asset);
    }
  }
  return { ok: errors.length === 0, errors, warnings, missingAssets: [...missingAssets].sort() };
}

function validateAudioTracks(root: string, manifest: ProjectManifest): void {
  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  for (const track of manifest.audioTracks || []) {
    if (trackIds.has(track.id)) throw new Error(`Duplicate audio track ID: ${track.id}`);
    trackIds.add(track.id);
    const sorted = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
    for (let index = 0; index < sorted.length; index++) {
      const clip = sorted[index];
      if (clipIds.has(clip.id)) throw new Error(`Duplicate audio clip ID: ${clip.id}`);
      clipIds.add(clip.id);
      safeRelative(root, clip.asset);
      if (index && sorted[index - 1].startFrame + sorted[index - 1].durationFrames > clip.startFrame) throw new Error(`Overlapping audio clips on ${track.name}`);
    }
  }
}

function validateScene(root: string, scene: Scene, manifest: ProjectManifest): void {
  const validate = manifest.formatVersion === 3 ? validSceneV3 : validScene;
  if (!validate(scene)) throw new Error(`Invalid scene: ${ajv.errorsText(validate.errors)}`);
  if (scene.program) {
    scriptPath(root, scene.program.entry, manifest.formatVersion);
    const capability = scene.program.renderer === 'webgl2' ? 'webgl2-scene' : 'canvas-scene';
    if (!manifest.capabilities?.includes(capability)) throw new Error(`Missing capability: ${capability}`);
    const edits = scene.program.edits;
    if (edits && manifest.sdkVersion !== '1.1.0') throw new Error('Program editing requires sdkVersion 1.1.0');
    const tracks = [...Object.values(edits?.parameters || {}), ...Object.values(edits?.objects || {}).flatMap(object => Object.values(object.properties)), ...Object.values(edits?.instances || {}).flatMap(instance => Object.values(instance.parameters))];
    for (const track of tracks) {
      let previous = -1;
      for (const key of track.keyframes || []) {
        if (key.frame <= previous || key.frame >= scene.durationFrames || typeof key.value !== typeof track.value) throw new Error('Program keys require ordered unique frames within scene duration and matching value types');
        previous = key.frame;
      }
      if (track.mode === 'offset' && typeof track.value !== 'number') throw new Error('Offset overrides require numeric values');
    }
  }
  if (scene.clip && (scene.clip.inFrame >= scene.clip.outFrame || scene.clip.outFrame > scene.durationFrames)) throw new Error(`Invalid clip range: ${scene.name}`);
  const layerIds = new Set<string>();
  for (const layer of scene.layers) {
    if (layerIds.has(layer.id)) throw new Error(`Duplicate layer ID: ${layer.id}`);
    layerIds.add(layer.id);
    if (layer.endFrame <= layer.startFrame || layer.endFrame > scene.durationFrames) throw new Error(`Invalid layer time: ${layer.name}`);
    if (layer.crop && (layer.crop.x + layer.crop.width > 1 || layer.crop.y + layer.crop.height > 1)) throw new Error(`Crop exceeds media bounds: ${layer.name}`);
    if (layer.asset) safeRelative(root, layer.asset);
    if (layer.mask) safeRelative(root, layer.mask);
    if (layer.script) safeRelative(root, layer.script);
    if (['image', 'svg', 'video', 'audio', 'model3d'].includes(layer.type) && !layer.asset) throw new Error(`Missing asset path: ${layer.name}`);
    if (layer.type === 'custom' && !layer.script) throw new Error(`Missing script path: ${layer.name}`);
    if (layer.type === 'svg' && layer.asset && !layer.asset.toLowerCase().endsWith('.svg')) throw new Error(`SVG layer requires .svg: ${layer.name}`);
    if (layer.type === 'model3d' && layer.asset && !/\.(glb|gltf)$/i.test(layer.asset)) throw new Error(`3D layer requires .glb or .gltf: ${layer.name}`);
    for (const keys of Object.values(layer.keyframes)) {
      if (keys.some(key => key.frame >= scene.durationFrames)) throw new Error(`Keyframe outside scene: ${layer.name}`);
      if (new Set(keys.map(key => key.frame)).size !== keys.length) throw new Error(`Duplicate keyframe: ${layer.name}`);
    }
    for (const [property, expression] of Object.entries(layer.expressions || {})) {
      if (!['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity', 'blur', 'brightness', 'saturation', 'volume', 'modelScale', 'modelYaw', 'modelPitch', 'modelRoll', 'cameraDistance', 'cameraFov', 'lightIntensity'].includes(property)
        && !(property.startsWith('params.') && typeof layer.params?.[property.slice(7)] === 'number')) throw new Error(`Expression requires a numeric property: ${layer.name}.${property}`);
      if (layer.keyframes[property]?.some(key => typeof key.value !== 'number')) throw new Error(`Expression requires numeric keyframes: ${layer.name}.${property}`);
      try { validateExpression(expression); } catch (error) { throw new Error(`Invalid expression ${layer.name}.${property}: ${String(error)}`); }
    }
    for (const [property, binding] of Object.entries(layer.bindings || {})) {
      if (!['text', 'color', 'blur', 'brightness', 'saturation', 'modelScale', 'modelYaw', 'modelPitch', 'modelRoll', 'cameraDistance', 'cameraFov', 'lightIntensity'].includes(property)
        && !(property.startsWith('params.') && Object.hasOwn(layer.params || {}, property.slice(7)))) throw new Error(`Unsupported data binding: ${layer.name}.${property}`);
      safeRelative(root, binding.asset);
      if (!binding.asset.toLowerCase().endsWith('.json')) throw new Error(`Data binding requires .json: ${layer.name}.${property}`);
      if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(binding.path)
        || binding.path.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error(`Invalid data path: ${layer.name}.${property}`);
    }
  }
}

export async function writeProject(root: string, project: LoadedProject, expectedRevision?: string, undo?: { id: string; project: LoadedProject }): Promise<LoadedProject> {
  if (![1, 2, 3].includes(project.manifest.formatVersion)) throw new Error('Unsupported project format version');
  const manifest = savedManifest(project);
  const validate = manifestValidator(manifest.formatVersion);
  if (!validate(manifest)) throw new Error(`Invalid project: ${ajv.errorsText(validate.errors)}`);
  validateAudioTracks(root, manifest);
  if (new Set(project.scenes.map(scene => scene.id)).size !== project.scenes.length) throw new Error('Duplicate scene ID');
  for (const scene of project.scenes) validateScene(root, scene, manifest);
  validateSources(root, project.sources, manifest.formatVersion);
  let oldReferences: string[] = [];
  let previousVersion: number | undefined;
  try {
    const previous = JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8')) as ProjectManifest;
    if (manifestValidator(previous.formatVersion)(previous)) {
      previousVersion = previous.formatVersion;
      oldReferences = previous.scenes.map(reference => reference.file);
    }
  } catch { /* A new project has no previous manifest. */ }
  const files: Record<string, FileContent> = { ...project.sources };
  if (manifest.formatVersion === 3 && previousVersion && previousVersion < 3) {
    const backup = `.aiscripter-backups/v${previousVersion}-${randomUUID()}`;
    for (const relative of await walk(root)) {
      files[`${backup}/${relative}`] = { copyFrom: await realProjectFile(root, relative) };
    }
  } else if (previousVersion === 1) {
    const backup = path.join(root, '.aiscripter-backups', `v1-${Date.now()}`);
    await fs.mkdir(path.join(backup, 'scenes'), { recursive: true });
    await fs.copyFile(path.join(root, 'project.json'), path.join(backup, 'project.json'));
    for (const relative of oldReferences) await fs.copyFile(await realProjectFile(root, relative), path.join(backup, relative));
  }
  if (undo) {
    if (!/^[a-f0-9-]{36}$/.test(undo.id)) throw new Error('Invalid undo ID');
    files[`.aiscripter/offline-undo/${undo.id}.json`] = JSON.stringify(undo.project);
  }
  for (const scene of project.scenes) files[`scenes/${scene.id}.json`] = `${JSON.stringify(scene, null, 2)}\n`;
  files['project.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
  const activeFiles = new Set(manifest.scenes.map(reference => reference.file));
  for (const file of oldReferences) {
    if (file.startsWith('scenes/') && file.endsWith('.json') && !activeFiles.has(file)) {
      files[file] = null;
    }
  }
  await persistFiles(root, files, async () => {
    if (expectedRevision !== undefined && await revisionOf(root) !== expectedRevision) throw new Error('REVISION_CONFLICT: disk changed');
  });
  return loadProject(root);
}

import type { RenderCommand, RenderResult } from '../shared/types';
import type { ProgramEdits, ProgramFeedback } from '../sdk';

export type ProgramCommand = { id: number; kind: 'frame' | 'dispose'; scriptUrl: string; resourceBase: string; revision: string;
  sceneId: string; edits?: ProgramEdits; renderer: '2d' | 'webgl2'; width: number; height: number; fps: number; durationFrames: number; seed: number; frame: number; params: Record<string, number | string | boolean> };
export type ProgramReply = { id: number; ok: true; bitmap?: ImageBitmap; initialized?: boolean; evaluateMs?: number; renderMs?: number; nodes?: number; programEdit?: ProgramFeedback } | { id: number; ok: false; error: string; stack?: string };
type Entry = { worker: Worker; instanceId: string; used: number; cancel?: () => void };
const instances = new Map<string, Entry>();
let requestId = 0, instanceId = 0;
type ImageRequest = { kind: 'image'; resourceId: number; relative: string };

async function decodeSvg(base: string, relative: string, revision: string): Promise<ImageBitmap> {
  if (!/^assets\/.+\.svg$/i.test(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part.startsWith('.'))) throw new Error('Invalid SVG asset path');
  const image = new Image(); image.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve(); image.onerror = () => reject(new Error(`Missing or invalid image: ${relative}`));
    image.src = `${base}${relative.split('/').map(encodeURIComponent).join('/')}?revision=${encodeURIComponent(revision)}`;
  });
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 8192 || image.naturalHeight > 8192) throw new Error(`Invalid image dimensions: ${relative}`);
  // Chromium's worker decoder cannot decode SVG blobs; rasterize in the same isolated hidden/preview renderer.
  const surface = document.createElement('canvas'); surface.width = image.naturalWidth; surface.height = image.naturalHeight;
  surface.getContext('2d')!.drawImage(image, 0, 0);
  return createImageBitmap(surface);
}

function dispose(entry: Entry): void {
  entry.cancel?.();
  const timer = window.setTimeout(() => entry.worker.terminate(), 500);
  entry.worker.onmessage = event => { if (event.data.ok && !event.data.bitmap) { window.clearTimeout(timer); entry.worker.terminate(); } else event.data.bitmap?.close(); };
  entry.worker.postMessage({ kind: 'dispose', id: ++requestId });
}

export async function renderProgram(command: RenderCommand): Promise<{ bitmap: ImageBitmap; stats: NonNullable<RenderResult['programStats']>; edit?: ProgramFeedback }> {
  const scene = command.project.scenes[command.sceneIndex], config = scene.program!;
  const compiled = command.project.programs?.[scene.id];
  if (!compiled?.path) throw new Error(compiled?.diagnostics.map(item => `${item.path || config.entry}${item.line ? `:${item.line}:${item.column}` : ''}: ${item.message}`).join('\n') || 'Program has not been compiled');
  const manifest = command.project.manifest;
  const key = JSON.stringify([command.host, command.project.root, command.project.revision, compiled.hash, scene.id, config.seed, config.renderer, manifest.width, manifest.height, manifest.fps, scene.durationFrames]);
  let entry = instances.get(key);
  if (!entry) {
    // A changed revision for one scene replaces its old instance, while scene switches retain a bounded cache.
    for (const [id, item] of instances) if (id !== key && JSON.parse(id)[4] === scene.id) { instances.delete(id); dispose(item); }
    if (instances.size >= 6) { const [id, oldest] = [...instances.entries()].sort((a, b) => a[1].used - b[1].used)[0]; instances.delete(id); dispose(oldest); }
    entry = { worker: new Worker(new URL('./program-worker.ts', import.meta.url), { type: 'module' }), instanceId: `program-${++instanceId}`, used: Date.now() };
    instances.set(key, entry);
  }
  const current = entry; current.used = Date.now();
  const resourceBase = `project://${command.host}/${command.project.resourcePrefix || ''}`;
  const message: ProgramCommand = { id: ++requestId, kind: 'frame', scriptUrl: `${resourceBase}${compiled.path}?revision=${encodeURIComponent(command.project.revision)}`,
    resourceBase, revision: command.project.revision, renderer: config.renderer, width: manifest.width, height: manifest.height,
    fps: manifest.fps, durationFrames: scene.durationFrames, seed: config.seed, frame: command.frame, params: config.params || {}, sceneId: scene.id, edits: config.edits };
  try {
    const result = await new Promise<Extract<ProgramReply, { ok: true }>>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Program exceeded the 8 second frame limit; its worker was terminated')), 8000);
      current.cancel = () => { window.clearTimeout(timer); reject(new Error('Program render superseded by a newer preview request')); };
      current.worker.onmessage = (event: MessageEvent<ProgramReply | ImageRequest>) => {
        if ('kind' in event.data) {
          const request = event.data;
          void decodeSvg(resourceBase, request.relative, command.project.revision).then(bitmap => {
            if (instances.get(key) !== current) { bitmap.close(); return; }
            current.worker.postMessage({ kind: 'image-result', resourceId: request.resourceId, bitmap }, [bitmap]);
          }).catch(error => { if (instances.get(key) === current) current.worker.postMessage({ kind: 'image-result', resourceId: request.resourceId, error: String(error) }); });
          return;
        }
        if (event.data.id !== message.id) { if (event.data.ok) event.data.bitmap?.close(); return; }
        window.clearTimeout(timer);
        if (event.data.ok) resolve(event.data);
        else { const error = new Error(event.data.error); if (event.data.stack) error.stack = event.data.stack; reject(error); }
      };
      current.worker.onerror = event => { window.clearTimeout(timer); reject(new Error(event.message || 'Program worker crashed')); };
      current.worker.postMessage(message);
    });
    if (!result.bitmap) throw new Error('Program did not return a frame');
    return { bitmap: result.bitmap, edit: result.programEdit, stats: { sceneId: scene.id, instanceId: current.instanceId, initialized: !!result.initialized,
      evaluateMs: result.evaluateMs || 0, renderMs: result.renderMs || 0, nodes: result.nodes || 0 } };
  } catch (error) { current.worker.terminate(); instances.delete(key); throw error; }
  finally { current.cancel = undefined; }
}

export function cancelProgramWork(): void {
  for (const [key, entry] of instances) if (entry.cancel) { entry.cancel(); entry.worker.terminate(); instances.delete(key); }
}

window.addEventListener('pagehide', () => { for (const item of instances.values()) item.worker.terminate(); instances.clear(); });

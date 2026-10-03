import { applyObjectEdits, describeNodes, drawNodes, resolveParameters, type CreateContext, type FrameContext, type Resources, type SceneFactory, type SceneInstance } from '../sdk';
import type { ProgramCommand, ProgramReply } from './program-pool';

type ImageReply = { kind: 'image-result'; resourceId: number; bitmap?: ImageBitmap; error?: string };
const scope = globalThis as typeof globalThis & { onmessage: ((event: MessageEvent<ProgramCommand | ImageReply>) => void) | null; postMessage(message: ProgramReply | { kind: 'image'; resourceId: number; relative: string }, transfer?: Transferable[]): void };
const fetchResource = globalThis.fetch.bind(globalThis);
const measure = performance.now.bind(performance);
let clock = 0;
const NativeDate = Date;
Object.defineProperty(globalThis, 'Date', { value: new Proxy(NativeDate, {
  apply: () => new NativeDate(clock).toString(),
  construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [clock], newTarget),
  get: (target, property, receiver) => property === 'now' ? () => clock : Reflect.get(target, property, receiver),
}) });
Object.defineProperty(performance, 'now', { value: () => clock });
const unavailable = () => { throw new Error('Use the SDK frame, seeded random channels and initialization resource API'); };
for (const name of ['setTimeout', 'setInterval', 'fetch', 'WebSocket', 'XMLHttpRequest', 'Worker', 'SharedWorker']) Object.defineProperty(globalThis, name, { value: unavailable });
Math.random = unavailable;
if (globalThis.crypto) for (const name of ['getRandomValues', 'randomUUID']) Object.defineProperty(globalThis.crypto, name, { value: unavailable });

let instance: SceneInstance | undefined, context: CreateContext | undefined;
let initializing = false;
const bitmaps = new Set<ImageBitmap>(), fonts: FontFace[] = [];
let resourceId = 0;
const imageRequests = new Map<number, { resolve(bitmap: ImageBitmap): void; reject(error: Error): void }>();
type WorkerFonts = { add(font: FontFace): void; delete(font: FontFace): void };

function resources(command: ProgramCommand): Resources {
  const reads = new Map<string, Promise<ArrayBuffer>>(), images = new Map<string, Promise<ImageBitmap>>();
  const read = (relative: string): Promise<ArrayBuffer> => {
    if (!initializing) throw new Error('Project resources may only be loaded during create()');
    if (!relative.startsWith('assets/') || relative.includes('\\') || relative.split('/').some(part => !part || part.startsWith('.'))) throw new Error(`Invalid asset path: ${relative}`);
    let result = reads.get(relative);
    if (!result) {
      result = fetchResource(`${command.resourceBase}${relative.split('/').map(encodeURIComponent).join('/')}?revision=${encodeURIComponent(command.revision)}`).then(async response => {
        if (!response.ok) throw new Error(`Missing resource: ${relative}`);
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 64 * 1024 * 1024) throw new Error(`Resource exceeds 64 MB: ${relative}`);
        return bytes;
      });
      reads.set(relative, result);
    }
    return result.then(bytes => bytes.slice(0));
  };
  return Object.freeze({ read,
    text: async relative => new TextDecoder().decode(await read(relative)),
    json: async <T>(relative: string) => JSON.parse(new TextDecoder().decode(await read(relative))) as T,
    image: async relative => {
      if (!initializing) throw new Error('Images may only be loaded during create()');
      let result = images.get(relative);
      if (!result) {
        const type = relative.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : relative.toLowerCase().endsWith('.png') ? 'image/png' : relative.toLowerCase().endsWith('.webp') ? 'image/webp' : relative.toLowerCase().endsWith('.gif') ? 'image/gif' : 'image/jpeg';
        result = read(relative).then(bytes => relative.toLowerCase().endsWith('.svg') ? new Promise<ImageBitmap>((resolve, reject) => {
          const id = ++resourceId;
          imageRequests.set(id, { resolve, reject }); scope.postMessage({ kind: 'image', resourceId: id, relative });
        }) : createImageBitmap(new Blob([bytes], { type }))).then(bitmap => { bitmaps.add(bitmap); return bitmap; }); images.set(relative, result);
      }
      return result;
    },
    font: async (family, relative, descriptors) => {
      const font = new FontFace(family, await read(relative), descriptors);
      await font.load();
      const fontSet = (globalThis as typeof globalThis & { fonts: WorkerFonts }).fonts;
      fontSet.add(font); fonts.push(font);
    },
  });
}

async function execute(command: ProgramCommand): Promise<ProgramReply> {
  if (command.kind === 'dispose') {
    try { await instance?.dispose?.(); }
    finally {
      for (const bitmap of bitmaps) bitmap.close();
      for (const font of fonts) (globalThis as typeof globalThis & { fonts: WorkerFonts }).fonts.delete(font);
      context?.gl?.getExtension('WEBGL_lose_context')?.loseContext(); instance = undefined; context = undefined;
    }
    return { id: command.id, ok: true };
  }
  const initialized = !instance;
  if (!instance) {
    clock = 0; initializing = true;
    try {
      const canvas = new OffscreenCanvas(command.width, command.height);
      const gl = command.renderer === 'webgl2' ? canvas.getContext('webgl2', { preserveDrawingBuffer: true }) : null;
      const ctx = command.renderer === '2d' ? canvas.getContext('2d') : null;
      if (!gl && !ctx) throw new Error(`${command.renderer} context unavailable`);
      context = { canvas, gl, ctx, width: command.width, height: command.height, fps: command.fps, durationFrames: command.durationFrames, seed: command.seed, resources: resources(command) };
      const module = await import(/* @vite-ignore */ command.scriptUrl) as { default?: SceneFactory };
      if (typeof module.default !== 'function') throw new Error('Program module must export default defineScene(create)');
      instance = await module.default(context);
      if (!instance || typeof instance.evaluate !== 'function') throw new Error('create() must return an instance with evaluate()');
    } finally { initializing = false; }
  }
  clock = command.frame / command.fps * 1000;
  const { resources: _resources, ...base } = context!;
  const edits = command.edits || {};
  const resolved = resolveParameters(instance.parameters || {}, command.params, edits.parameters, command.frame);
  const frame: FrameContext = { ...base, frame: command.frame, time: command.frame / command.fps, params: Object.freeze(resolved.values), instances: edits.instances };
  const start = measure();
  const evaluated = await instance.evaluate(frame);
  const codeDescriptions = evaluated === undefined ? [] : describeNodes(evaluated, frame.ctx);
  const applied = applyObjectEdits(evaluated || [], edits, command.frame);
  const nodes = evaluated === undefined ? undefined : applied.nodes;
  const descriptions = describeNodes(nodes || [], frame.ctx, edits);
  const codeById = new Map(codeDescriptions.map(node => [node.id, node.properties]));
  for (const description of descriptions) description.codeProperties = codeById.get(description.id);
  const diagnostics = [...resolved.diagnostics, ...applied.diagnostics];
  for (const [id, edit] of Object.entries(edits.instances || {})) {
    const descriptor = codeDescriptions.find(node => node.id === id)?.component;
    if (!descriptor) diagnostics.push({ target: id, message: 'Component instance absent; parameter overrides retained' });
    else diagnostics.push(...resolveParameters(descriptor.parameters, descriptor.values, edit.parameters, command.frame).diagnostics.map(item => ({ ...item, target: `${id}/${item.target}` })));
  }
  const evaluateMs = measure() - start;
  frame.ctx?.reset();
  if (frame.gl) {
    if (frame.gl.isContextLost()) throw new Error('WebGL context lost; retry to recreate the instance');
    frame.gl.bindFramebuffer(frame.gl.FRAMEBUFFER, null); frame.gl.viewport(0, 0, frame.width, frame.height);
    frame.gl.clearColor(0, 0, 0, 0); frame.gl.clear(frame.gl.COLOR_BUFFER_BIT | frame.gl.DEPTH_BUFFER_BIT);
  }
  const renderStart = measure();
  if (instance.render) await instance.render(frame, nodes);
  else if (nodes && frame.ctx) drawNodes(frame.ctx, nodes);
  else if (nodes?.length) throw new Error('WebGL scenes must implement render()');
  return { id: command.id, ok: true, bitmap: frame.canvas.transferToImageBitmap(), initialized,
    evaluateMs, renderMs: measure() - renderStart, nodes: descriptions.length,
    programEdit: { sceneId: command.sceneId, frame: command.frame, nodes: descriptions, parameters: instance.parameters || {}, values: resolved.values, diagnostics } };
}

let queue = Promise.resolve();
scope.onmessage = event => {
  if (event.data.kind === 'image-result') {
    const pending = imageRequests.get(event.data.resourceId);
    imageRequests.delete(event.data.resourceId);
    if (event.data.bitmap && pending) pending.resolve(event.data.bitmap);
    else if (pending) pending.reject(new Error(event.data.error || 'Image decoding failed'));
    else event.data.bitmap?.close();
    return;
  }
  const command = event.data;
  queue = queue.then(async () => {
    try { const result = await execute(command); scope.postMessage(result, result.ok && result.bitmap ? [result.bitmap] : []); }
    catch (error) { scope.postMessage({ id: command.id, ok: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack?.slice(0, 4000) : undefined }); }
  });
};

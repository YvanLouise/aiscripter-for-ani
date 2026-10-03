type SetupApi = { readProjectFile: (relative: string) => Promise<ArrayBuffer> };
type RenderApi = {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D | null;
  gl: WebGL2RenderingContext | null;
  width: number;
  height: number;
  frame: number;
  timeSeconds: number;
  params: Record<string, unknown>;
  seed: number;
  state: unknown;
};
type CustomModule = { setup?: (api: SetupApi) => unknown | Promise<unknown>; render: (api: RenderApi) => void | Promise<void> };
type Command = {
  scriptUrl: string;
  host: 'active' | 'export';
  revision: string;
  resourcePrefix?: string;
  renderer: '2d' | 'webgl2';
  width: number;
  height: number;
  frame: number;
  fps: number;
  params: Record<string, unknown>;
  seed: number;
};
type Result = { ok: true; bitmap: ImageBitmap } | { ok: false; error: string; stack?: string };
const workerScope = globalThis as typeof globalThis & {
  onmessage: ((event: MessageEvent<Command>) => void) | null;
  postMessage: (message: Result, transfer?: Transferable[]) => void;
};

function projectUrl(host: string, relative: string, revision: string, prefix = ''): string {
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid project path: ${relative}`);
  }
  return `project://${host}/${prefix}${relative.split('/').map(encodeURIComponent).join('/')}?revision=${encodeURIComponent(revision)}`;
}

function fixedEnvironment(seed: number, timeMs: number): void {
  let current = seed >>> 0;
  Math.random = () => {
    current ^= current << 13;
    current ^= current >>> 17;
    current ^= current << 5;
    return (current >>> 0) / 0x100000000;
  };
  const NativeDate = Date;
  const FixedDate = new Proxy(NativeDate, {
    apply: () => new NativeDate(timeMs).toString(),
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [timeMs], newTarget),
    get: (target, property, receiver) => property === 'now' ? () => timeMs : Reflect.get(target, property, receiver),
  });
  Object.defineProperty(globalThis, 'Date', { value: FixedDate, writable: false });
  Object.defineProperty(performance, 'now', { value: () => timeMs, writable: false });
  const unsupported = () => { throw new Error('Timers and system randomness are unavailable in frame rendering'); };
  Object.defineProperty(globalThis, 'setTimeout', { value: unsupported });
  Object.defineProperty(globalThis, 'setInterval', { value: unsupported });
  if (globalThis.crypto) {
    Object.defineProperty(globalThis.crypto, 'getRandomValues', { value: unsupported });
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: unsupported });
  }
}

async function execute(command: Command): Promise<ImageBitmap> {
  fixedEnvironment(command.seed, Math.round(command.frame / command.fps * 1000));
  const surface = new OffscreenCanvas(command.width, command.height);
  const gl = command.renderer === 'webgl2' ? surface.getContext('webgl2', { preserveDrawingBuffer: true }) : null;
  const ctx = command.renderer === 'webgl2' ? null : surface.getContext('2d');
  if (!gl && !ctx) throw new Error(`${command.renderer} context unavailable`);
  const module = await import(/* @vite-ignore */ command.scriptUrl) as CustomModule;
  if (typeof module.render !== 'function') throw new Error('Custom module must export render()');
  const readProjectFile = async (relative: string): Promise<ArrayBuffer> => {
    const response = await fetch(projectUrl(command.host, relative, command.revision, command.resourcePrefix));
    if (!response.ok) throw new Error(`Unable to read ${relative}`);
    return response.arrayBuffer();
  };
  const state = module.setup ? await module.setup({ readProjectFile }) : undefined;
  ctx?.clearRect(0, 0, command.width, command.height);
  if (gl) { gl.viewport(0, 0, command.width, command.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  await module.render({ canvas: surface, ctx, gl, width: command.width, height: command.height,
    frame: command.frame, timeSeconds: command.frame / command.fps, params: command.params, seed: command.seed, state });
  return surface.transferToImageBitmap();
}

workerScope.onmessage = event => {
  void execute(event.data).then(bitmap => workerScope.postMessage({ ok: true, bitmap }, [bitmap]))
    .catch(error => workerScope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack?.slice(0, 4000) : undefined }));
};

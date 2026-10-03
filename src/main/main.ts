import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, session, shell, webContents, type Session } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, mkdtempSync, realpathSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ExportKind, ExportOptions, LoadedProject, RenderCommand, RenderResult } from '../shared/types';
import { clipBounds, sceneAtFrame, totalFrames } from '../shared/animation';
import { resolveExportRange } from '../shared/export-range';
import { diffProjects } from '../shared/project-diff';
import { listHistory, restoreHistory, saveHistory } from './history';
import { volumeFilter } from './audio-volume';
import { prepareDefaultProject } from './sample';
import { checkProject, createProject, loadProject, readScript, realProjectFile, revisionOf, safeRelative, validateSources, writeProject, writeScript } from './project';
import { AiProjectService, importAsset } from './ai-service';
import { startBridge, type BridgeRequest } from './ai-bridge';
import type { AiChange, AiSession, AiStage, EditorAiRequest, AiJob } from '../shared/ai-service';
import { runAiQa } from './ai-qa';
import { projectCopyFilter } from './project-copy';
import { buildPrograms } from './program-build';
import { runProgramQa } from './program-qa';
import { runObjectEditQa } from './object-edit-qa';
import { runDefaultDemoQa } from './default-demo-qa';
import { bundledContentRoot } from './content';

const launchDirectory = process.cwd();
const tempRoot = realpathSync(os.tmpdir());
const runtimeDirectory = mkdtempSync(path.join(tempRoot, 'aiscripter-runtime-'));
process.chdir(runtimeDirectory);
// Native Windows spelling initialization can create malformed relative directories in restricted accounts.
const cleanupRuntimeScript = `
const fs = require('node:fs');
const path = require('node:path');
const [root, directory, owner] = process.argv.slice(1);
const deadline = Date.now() + 120000;
function clean() {
  if (Date.now() > deadline) return;
  try { process.kill(Number(owner), 0); setTimeout(clean, 500); return; }
  catch (error) { if (error.code === 'EPERM') { setTimeout(clean, 500); return; } }
  try {
    const base = fs.realpathSync(root);
    const target = fs.realpathSync(directory);
    if (!target.toLowerCase().startsWith((base + path.sep).toLowerCase())) return;
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') setTimeout(clean, 500);
  }
}
clean();`;
app.on('quit', () => {
  const cleanup = spawn(process.execPath, ['-e', cleanupRuntimeScript, tempRoot, runtimeDirectory, String(process.pid)], {
    cwd: tempRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true,
  });
  cleanup.on('error', error => console.error('Could not start runtime cleanup:', error));
  cleanup.unref();
});

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'project', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let editor: BrowserWindow;
let activeRoot: string | undefined;
let exportRoot: string | undefined;
let loadedRevision = '';
let closeBridge: (() => Promise<void>) | undefined;
const editorCalls = new Map<string, { resolve: (value: AiSession) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const sourceSnapshots = new Map<string, { root: string; sources: Record<string, string>; programs: LoadedProject['programs']; created: number }>();
let activeSnapshotKey = '';
let outputQueue: Promise<unknown> = Promise.resolve();
const aiJobs = new Map<string, { info: AiJob; controller: AbortController }>();
const aiDiagnostics = new Map<string, unknown>();
let watcher: FSWatcher | undefined;
let watchTimer: ReturnType<typeof setTimeout> | undefined;
let thumbnailWindow: BrowserWindow | undefined;
let thumbnailQueue = Promise.resolve();
let detectedFfmpeg: string | null | undefined;
const thumbnailCache = new Map<string, string>();
const waveformCache = new Map<string, string>();
const restrictedSessions = new WeakSet<Session>();
const pending = new Map<string, { senderId: number; resolve: (result: RenderResult) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const distRoot = path.join(app.getAppPath(), 'dist');
const contentRoot = bundledContentRoot(app.getAppPath());
const runtimePreload = path.join(__dirname, 'runtime-preload.js');

function askEditor(request: Omit<EditorAiRequest, 'id'>): Promise<AiSession> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { editorCalls.delete(id); reject(new Error('EDITOR_BUSY: editor did not respond')); }, 15000);
    editorCalls.set(id, { resolve, reject, timer });
    editor.webContents.send('ai:request', { ...request, id });
  });
}

async function prepareSources(project: LoadedProject, active = true): Promise<LoadedProject> {
  if (active) assertCurrent(project);
  validateSources(project.root, project.sources, project.manifest.formatVersion);
  const key = createHash('sha256').update(JSON.stringify([project.root, project.revision, project.sources || {}, project.scenes.map(scene => [scene.id, scene.program?.entry])])).digest('hex');
  if (!sourceSnapshots.has(key)) {
    const compiled = await buildPrograms(project);
    sourceSnapshots.set(key, { root: project.root, sources: { ...project.sources, ...compiled.sources }, programs: compiled.programs, created: Date.now() });
  }
  if (active) activeSnapshotKey = key;
  sourceSnapshots.get(key)!.created = Date.now();
  for (const [id, snapshot] of sourceSnapshots) if (id !== key && id !== activeSnapshotKey && snapshot.root !== exportRoot && snapshot.created < Date.now() - 60000) sourceSnapshots.delete(id);
  return { ...project, sources: undefined, programs: sourceSnapshots.get(key)!.programs, resourcePrefix: `__draft/${key}/` };
}

function queuedOutput<T>(action: () => Promise<T>): Promise<T> {
  const task = outputQueue.then(action);
  outputQueue = task.catch(() => undefined);
  return task;
}

async function freezeProject(project: LoadedProject): Promise<{ base: string; project: LoadedProject }> {
  const base = await fs.mkdtemp(path.join(runtimeDirectory, 'ai-'));
  try {
    const before = await revisionOf(project.root);
    if (before !== project.revision) throw new Error('REVISION_CONFLICT: disk changed before snapshot');
    const root = path.join(base, 'project');
    await fs.cp(project.root, root, { recursive: true, filter: async file => {
      const relative = path.relative(project.root, file);
      return (!relative || !relative.split(path.sep).some(part => part.startsWith('.'))) && !(await fs.lstat(file)).isSymbolicLink();
    } });
    if (await revisionOf(project.root) !== before) throw new Error('REVISION_CONFLICT: disk changed while taking snapshot');
    return { base, project: await writeProject(root, project) };
  } catch (error) { await fs.rm(base, { recursive: true, force: true }); throw error; }
}

async function handleAiRequest(request: BridgeRequest, read: () => Promise<AiSession>, service: AiProjectService): Promise<unknown> {
  const args = request.args as Record<string, any> || {};
  switch (request.method) {
    case 'session': return read();
    case 'stage': return service.stage(args.expectedDraftRevision, args.expectedDiskRevision, args.changes as AiChange[]);
    case 'commit': return service.commit(args.id);
    case 'discard': service.discard(args.id); return { discarded: true };
    case 'import': {
      const state = await read();
      if (state.draftRevision !== args.expectedDraftRevision || state.diskRevision !== args.expectedDiskRevision || state.project.revision !== state.diskRevision) throw new Error('REVISION_CONFLICT: inspect again');
      const relative = args.relativePath as string;
      loadedRevision = await importAsset(state.project.root, state.diskRevision, relative, args.base64);
      const session = await askEditor({ kind: 'rebase', project: { ...state.project, revision: loadedRevision } });
      return { relativePath: relative, session };
    }
    case 'save': {
      const session = await read();
      if (session.draftRevision !== args.expectedDraftRevision || session.diskRevision !== args.expectedDiskRevision) throw new Error('REVISION_CONFLICT: inspect again');
      return askEditor({ kind: 'save', expectedDraftRevision: session.draftRevision });
    }
    case 'diagnostics': {
      const session = await read();
      return { draftRevision: session.draftRevision, check: await checkProject(session.project), build: (await buildPrograms(session.project)).diagnostics, runtime: aiDiagnostics.get(session.draftRevision) || null };
    }
    case 'build': {
      const session = await read();
      if (session.draftRevision !== args.draftRevision) throw new Error('REVISION_CONFLICT: inspect again');
      const built = await buildPrograms(session.project);
      return { draftRevision: session.draftRevision, ok: !built.diagnostics.length, programs: built.programs, diagnostics: built.diagnostics };
    }
    case 'render': {
      const session = await read();
      if (session.draftRevision !== args.draftRevision) throw new Error('REVISION_CONFLICT: inspect again');
      const frames = args.frames as number[];
      const width = args.width ?? 960, height = args.height ?? 540;
      if (!Array.isArray(frames) || !frames.length || frames.length > 6 || frames.some(frame => !Number.isInteger(frame) || frame < 0 || frame >= totalFrames(session.project.scenes))) throw new Error('Request 1 to 6 valid global frames');
      if (![width, height].every(Number.isInteger) || width < 16 || height < 16 || width > 1920 || height > 1080) throw new Error('Invalid preview dimensions');
      const snapshot = await freezeProject(session.project);
      return queuedOutput(async () => {
        let window: BrowserWindow | undefined;
        const outputs = [];
        try {
          exportRoot = snapshot.project.root;
          const prepared = await prepareSources(snapshot.project, false);
          window = await createExportWindow(`ani-export-${randomUUID()}`);
          for (const globalFrame of frames) {
            const position = sceneAtFrame(snapshot.project.scenes, globalFrame);
            const started = Date.now();
            const rendered = await waitForRender(window, { requestId: randomUUID(), project: prepared, ...position, host: 'export', capture: true, captureSize: { width, height } });
            outputs.push({ globalFrame, ...position, sceneId: snapshot.project.scenes[position.sceneIndex].id, width, height, milliseconds: Date.now() - started, ...rendered });
          }
          aiDiagnostics.set(session.draftRevision, outputs.map(({ png: _png, ...item }) => item));
          if (aiDiagnostics.size > 32) aiDiagnostics.delete(aiDiagnostics.keys().next().value!);
          return { draftRevision: session.draftRevision, diskRevision: session.diskRevision, frames: outputs };
        } finally { window?.destroy(); exportRoot = undefined; await fs.rm(snapshot.base, { recursive: true, force: true }); }
      });
    }
    case 'export': {
      const session = await read();
      if (session.draftRevision !== args.draftRevision) throw new Error('REVISION_CONFLICT: inspect again');
      const start = args.startFrame, end = args.endFrame;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > totalFrames(session.project.scenes) || end - start > session.project.manifest.fps * 30) throw new Error('Preview range must be valid and at most 30 seconds');
      if ([...aiJobs.values()].filter(job => ['queued', 'running'].includes(job.info.state)).length >= 4) throw new Error('Preview queue is full');
      const snapshot = await freezeProject(session.project);
      const id = randomUUID();
      const job = { info: { id, state: 'queued', progress: 0, draftRevision: session.draftRevision } as AiJob, controller: new AbortController() };
      aiJobs.set(id, job);
      void queuedOutput(async () => {
        try {
          job.controller.signal.throwIfAborted(); job.info.state = 'running';
          const destination = path.join(snapshot.base, 'preview.mp4');
          await exportProject(session.project, 'mp4', 0, 0, destination, { width: 960, height: 540, fps: session.project.manifest.fps, quality: 'draft', scope: 'range', startFrame: start, endFrame: end }, job.controller.signal, progress => { job.info.progress = progress; }, snapshot.project.root);
          job.controller.signal.throwIfAborted();
          job.info.output = destination; job.info.state = 'complete'; job.info.progress = 1;
        } catch (error) { job.info.state = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.info.error = String(error); await fs.rm(snapshot.base, { recursive: true, force: true }); }
      });
      return job.info;
    }
    case 'job':
    case 'cancel': {
      const job = aiJobs.get(args.id);
      if (!job) throw new Error('Job ID not found');
      if (request.method === 'cancel' && ['queued', 'running'].includes(job.info.state)) job.controller.abort();
      return job.info;
    }
    default: throw new Error('Unknown project service method');
  }
}

app.on('before-quit', event => {
  if (!closeBridge) return;
  event.preventDefault();
  const close = closeBridge; closeBridge = undefined;
  for (const job of aiJobs.values()) job.controller.abort();
  void close().finally(() => app.quit());
});

function mimeFor(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    default: return 'application/octet-stream';
  }
}

async function responseForFile(file: string): Promise<Response> {
  try {
    return new Response(await fs.readFile(file), { headers: {
      'Content-Type': mimeFor(file),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

async function responseForMedia(file: string, request: Request): Promise<Response> {
  const stat = await fs.stat(file);
  const range = request.headers.get('range')?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(stat.size - 1, Number(range[2])) : stat.size - 1;
  if (start >= stat.size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
  const headers: Record<string, string> = {
    'Content-Type': mimeFor(file), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  const stream = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, { status: range ? 206 : 200, headers });
}

function registerProtocols(partition?: string): void {
  const target = partition ? session.fromPartition(partition) : session.defaultSession;
  target.protocol.handle('app', async request => {
    const url = new URL(request.url);
    if (!['editor', 'runtime'].includes(url.hostname)) return new Response('Forbidden', { status: 403 });
    const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
    if (!relative || relative.includes('\\') || relative.split('/').some(part => part === '..')) return new Response('Forbidden', { status: 403 });
    const file = path.resolve(distRoot, ...relative.split('/'));
    if (!file.startsWith(distRoot + path.sep)) return new Response('Forbidden', { status: 403 });
    return responseForFile(file);
  });
  target.protocol.handle('project', async request => {
    try {
      const url = new URL(request.url);
      const root = url.hostname === 'active' ? activeRoot : url.hostname === 'export' ? exportRoot : undefined;
      if (!root) return new Response('No project', { status: 404 });
      let relative = decodeURIComponent(url.pathname).replace(/^\//, '');
      const snapshotPath = relative.match(/^__draft\/([a-f0-9]{64})\/(.+)$/);
      if (snapshotPath) {
        const snapshot = sourceSnapshots.get(snapshotPath[1]);
        if (!snapshot || snapshot.root !== root) return new Response('Draft expired', { status: 404 });
        relative = snapshotPath[2];
        safeRelative(root, relative);
        if (Object.hasOwn(snapshot.sources, relative)) return new Response(snapshot.sources[relative], { headers: { 'Content-Type': mimeFor(relative), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
      }
      if (relative.split('/').some(part => part.startsWith('.'))) return new Response('Private project metadata', { status: 403 });
      const file = await realProjectFile(root, relative);
      return /\.(mp4|webm|mp3|wav|ogg)$/i.test(file) ? responseForMedia(file, request) : responseForFile(file);
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  });
}

function restrictRuntime(partition: string): void {
  const target = session.fromPartition(partition);
  if (restrictedSessions.has(target)) return;
  registerProtocols(partition);
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.webRequest.onBeforeRequest((details, callback) => {
    const projectHost = partition.startsWith('ani-export-') ? 'export' : 'active';
    const allowed = details.url.startsWith('app://runtime/') || details.url.startsWith(`project://${projectHost}/`);
    callback({ cancel: !allowed });
  });
  restrictedSessions.add(target);
}

async function setProject(root: string): Promise<LoadedProject> {
  const project = await loadProject(root);
  await closeBridge?.();
  closeBridge = undefined;
  await watcher?.close();
  activeRoot = root;
  thumbnailWindow?.destroy();
  thumbnailWindow = undefined;
  thumbnailCache.clear();
  waveformCache.clear();
  loadedRevision = project.revision;
  const read = async (): Promise<AiSession> => {
    const state = await askEditor({ kind: 'inspect' });
    if (state.project.root !== activeRoot) throw new Error('Project session changed');
    state.diskRevision = await revisionOf(root);
    return state;
  };
  const service = new AiProjectService(read, async (next, expected) => {
    if (await revisionOf(root) !== expected.expectedDiskRevision) throw new Error('REVISION_CONFLICT: disk changed');
    return askEditor({ kind: 'apply', project: next, expectedDraftRevision: expected.expectedDraftRevision });
  });
  closeBridge = await startBridge(root, request => handleAiRequest(request, read, service));
  watcher = chokidar.watch(root, { ignored: (file) => path.relative(root, file).split(path.sep).some(part => part.startsWith('.')), ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 } });
  watcher.on('all', () => {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(async () => {
      try {
        if (activeRoot === root && await revisionOf(root) !== loadedRevision) editor.webContents.send('project:external-change');
      } catch { editor.webContents.send('project:external-change'); }
    }, 300);
  });
  await rememberRecent(root);
  return project;
}

async function recentProjects(): Promise<string[]> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'recent-projects.json'), 'utf8'));
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 10) : [];
  } catch { return []; }
}

async function rememberRecent(root: string): Promise<void> {
  if (root === path.join(app.getAppPath(), 'examples', 'solar-system')) return;
  const list = [root, ...(await recentProjects()).filter(item => item !== root)].slice(0, 10);
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(path.join(app.getPath('userData'), 'recent-projects.json'), JSON.stringify(list, null, 2));
}

function assertCurrent(project: LoadedProject): string {
  if (!activeRoot || project.root !== activeRoot) throw new Error('Project is not open');
  return activeRoot;
}

async function listResourceFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(path.join(root, directory), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const relative = path.posix.join(directory.replaceAll('\\', '/'), entry.name);
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) results.push(relative);
    }
  };
  await visit('assets');
  return results.sort();
}

function ffmpegPath(): string | undefined {
  if (detectedFfmpeg !== undefined) return detectedFfmpeg || undefined;
  const candidates = app.isPackaged ? [path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'), 'ffmpeg'] : ['ffmpeg'];
  try { candidates.push(require('@ffmpeg-installer/ffmpeg').path as string); } catch { /* Optional local binary. */ }
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0 && result.stdout.includes('libx264')) { detectedFfmpeg = candidate; return candidate; }
  }
  detectedFfmpeg = null;
  return undefined;
}

function ffmpegAvailable(): boolean {
  return Boolean(ffmpegPath());
}

function waitForRender(window: BrowserWindow, command: RenderCommand): Promise<RenderResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(command.requestId);
      reject(new Error(`Render timed out at frame ${command.frame}`));
    }, 30000);
    pending.set(command.requestId, { senderId: window.webContents.id, resolve, reject, timer });
    window.webContents.send('runtime:command', command);
  });
}

async function createExportWindow(partition: string): Promise<BrowserWindow> {
  restrictRuntime(partition);
  const window = new BrowserWindow({
    show: false, width: 1920, height: 1080, useContentSize: true,
    webPreferences: { partition, preload: runtimePreload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await window.loadURL('app://runtime/runtime.html');
  return window;
}

async function audioForExport(project: LoadedProject, root: string, range: { start: number; end: number }): Promise<{ inputs: string[]; filter?: string }> {
  const inputs: string[] = [];
  const filters: string[] = [];
  const names: string[] = [];
  let sceneOffset = 0;
  for (const scene of project.scenes) {
    const bounds = clipBounds(scene);
    for (const layer of scene.layers) {
      if (layer.type !== 'audio' || !layer.visible || layer.muted || !layer.asset) continue;
      const start = Math.max(bounds.inFrame, layer.startFrame);
      const end = Math.min(bounds.outFrame, layer.endFrame);
      if (end <= start) continue;
      const file = await realProjectFile(root, layer.asset);
      const index = names.length;
      inputs.push(...(layer.loop ? ['-stream_loop', '-1'] : []), '-i', file);
      const delay = Math.round((sceneOffset + start - bounds.inFrame) / project.manifest.fps * 1000);
      const duration = (end - start) / project.manifest.fps;
      const volume = volumeFilter(layer, start, end, project.manifest.fps);
      const fadeIn = Math.min(duration, (layer.fadeInFrames || 0) / project.manifest.fps);
      const fadeOut = Math.min(duration, (layer.fadeOutFrames || 0) / project.manifest.fps);
      const fades = `${fadeIn ? `,afade=t=in:st=0:d=${fadeIn}` : ''}${fadeOut ? `,afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}` : ''}`;
      const name = `audio${index}`;
      filters.push(`[${index + 1}:a]atrim=start=${(start - layer.startFrame) / project.manifest.fps}:duration=${duration},asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo,${volume}${fades},adelay=${delay}|${delay}[${name}]`);
      names.push(`[${name}]`);
    }
    sceneOffset += bounds.outFrame - bounds.inFrame;
  }
  for (const track of project.manifest.audioTracks || []) {
    for (const clip of track.clips) {
      const visible = Math.min(clip.durationFrames, totalFrames(project.scenes) - clip.startFrame);
      if (clip.muted || visible <= 0) continue;
      const file = await realProjectFile(root, clip.asset);
      const index = names.length;
      inputs.push(...(clip.loop ? ['-stream_loop', '-1'] : []), '-i', file);
      const delay = Math.round(clip.startFrame / project.manifest.fps * 1000);
      const name = `audio${index}`;
      const duration = visible / project.manifest.fps;
      const fadeIn = Math.min(duration, (clip.fadeInFrames || 0) / project.manifest.fps);
      const fadeOut = Math.min(duration, (clip.fadeOutFrames || 0) / project.manifest.fps);
      const fades = `${fadeIn ? `,afade=t=in:st=0:d=${fadeIn}` : ''}${fadeOut ? `,afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}` : ''}`;
      filters.push(`[${index + 1}:a]atrim=start=${clip.sourceInFrame / project.manifest.fps}:duration=${duration},asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo,volume=${clip.volume}${fades},adelay=${delay}|${delay}[${name}]`);
      names.push(`[${name}]`);
    }
  }
  if (!names.length) return { inputs };
  if (names.length > 1) filters.push(`${names.join('')}amix=inputs=${names.length}:dropout_transition=0[audiomix]`);
  filters.push(`${names.length === 1 ? names[0] : '[audiomix]'}atrim=start=${range.start / project.manifest.fps}:duration=${(range.end - range.start) / project.manifest.fps},asetpts=PTS-STARTPTS[audioout]`);
  return { inputs, filter: filters.join(';') };
}

async function waveform(project: LoadedProject, asset: string, width: number, sourceInFrame: number, durationFrames: number): Promise<string> {
  const root = assertCurrent(project);
  const file = await realProjectFile(root, asset);
  const key = `${project.revision}:${asset}:${width}:${sourceInFrame}:${durationFrames}`;
  const cached = waveformCache.get(key);
  if (cached) return cached;
  const executable = ffmpegPath();
  if (!executable) throw new Error('FFmpeg unavailable');
  const result = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-ss', String(sourceInFrame / project.manifest.fps), '-t', String(durationFrames / project.manifest.fps), '-i', file, '-filter_complex', `showwavespic=s=${Math.max(64, Math.min(2048, Math.round(width)))}x80:colors=0x5baeff`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-300); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0 && size > 0) resolve(Buffer.concat(chunks)); else reject(new Error(`Waveform failed: ${stderr}`)); });
  });
  const data = `data:image/png;base64,${result.toString('base64')}`;
  waveformCache.set(key, data);
  return data;
}

async function thumbnail(project: LoadedProject, sceneIndex: number, frame: number): Promise<string> {
  assertCurrent(project);
  const key = createHash('sha256').update(JSON.stringify([project.root, project.revision, project.sources, project.scenes[sceneIndex], frame])).digest('hex');
  const cached = thumbnailCache.get(key);
  if (cached) return cached;
  if (!thumbnailWindow || thumbnailWindow.isDestroyed()) thumbnailWindow = await createExportWindow('ani-thumbnail');
  const window = thumbnailWindow;
  try {
    const result = await waitForRender(window, { requestId: randomUUID(), project: await prepareSources(project), sceneIndex, frame, host: 'active', capture: true, captureSize: { width: 240, height: 135 } });
    if (!result.ok || !result.png || result.errors?.length) throw new Error(result.error || result.errors?.join('; ') || 'Thumbnail failed');
    thumbnailCache.set(key, result.png);
    if (thumbnailCache.size > 120) thumbnailCache.delete(thumbnailCache.keys().next().value!);
    return result.png;
  } catch (error) {
    if (thumbnailWindow === window) {
      if (!window.isDestroyed()) window.destroy();
      thumbnailWindow = undefined;
    }
    throw error;
  }
}

async function exportProject(project: LoadedProject, kind: ExportKind, sceneIndex: number, frame: number, forcedPath?: string, options?: ExportOptions, signal?: AbortSignal, onProgress?: (progress: number) => void, sourceRoot?: string): Promise<string | undefined> {
  const root = assertCurrent(project);
  if (kind === 'png' && (!Number.isInteger(frame) || frame < 0 || frame >= (project.scenes[sceneIndex]?.durationFrames ?? 0))) throw new Error('Frame is outside the selected scene');
  const output = options || { width: project.manifest.width, height: project.manifest.height, fps: project.manifest.fps };
  if (![output.width, output.height, output.fps].every(Number.isInteger) || output.width < 1 || output.height < 1 || output.width > 8192 || output.height > 8192 || output.fps < 1 || output.fps > 120) throw new Error('Invalid export resolution or frame rate');
  if (kind === 'mp4' && (output.width % 2 || output.height % 2)) throw new Error('Export width and height must be even for H.264');
  const range = kind === 'png' ? undefined : resolveExportRange(project.scenes, sceneIndex, output);
  const encoderPath = ['mp4', 'webm', 'gif'].includes(kind) ? ffmpegPath() : undefined;
  if (['mp4', 'webm', 'gif'].includes(kind) && !encoderPath) throw new Error('FFmpeg is required for video export');
  let destination = forcedPath;
  if (!destination) {
    if (kind === 'sequence') {
      const chosen = await dialog.showOpenDialog(editor, { title: 'Choose folder for PNG sequence', properties: ['openDirectory', 'createDirectory'] });
      if (chosen.canceled || !chosen.filePaths[0]) return undefined;
      destination = path.join(chosen.filePaths[0], `${project.manifest.name.replace(/[\\/:*?"<>|]/g, '_')}-frames-${Date.now()}`);
    } else {
      const chosen = await dialog.showSaveDialog(editor, {
        title: kind === 'png' ? 'Export frame' : 'Export animation',
        defaultPath: `${project.manifest.name}.${kind}`,
        filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
      });
      if (chosen.canceled || !chosen.filePath) return undefined;
      destination = chosen.filePath;
    }
  }
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-export-'));
  const frozenRoot = path.join(base, 'project');
  let window: BrowserWindow | undefined;
  try {
    signal?.throwIfAborted();
    await fs.cp(sourceRoot || root, frozenRoot, { recursive: true, filter: async file => !(await fs.lstat(file)).isSymbolicLink() && !path.relative(sourceRoot || root, file).split(path.sep).some(part => part.startsWith('.')) });
    exportRoot = frozenRoot;
    const frozen = await prepareSources(await writeProject(frozenRoot, project), false);
    window = await createExportWindow(`ani-export-${randomUUID()}`);
    if (kind === 'png') {
      const result = await waitForRender(window, { requestId: randomUUID(), project: frozen, sceneIndex, frame, host: 'export', capture: true, captureSize: output, transparentBackground: output.transparentBackground });
      if (!result.ok || !result.png || result.errors?.length) throw new Error(result.error || result.errors?.join('; ') || 'Frame render failed');
      await fs.writeFile(destination, Buffer.from(result.png.split(',')[1], 'base64'));
    } else {
      const frames = Math.ceil((range!.end - range!.start) * output.fps / frozen.manifest.fps);
      const frameAt = (index: number) => sceneAtFrame(frozen.scenes, Math.min(range!.end - 1, range!.start + Math.floor(index * frozen.manifest.fps / output.fps)));
      if (kind === 'sequence') {
        await fs.mkdir(destination, { recursive: false });
        for (let index = 0; index < frames; index++) {
          signal?.throwIfAborted();
          const result = await waitForRender(window, { requestId: randomUUID(), project: frozen, ...frameAt(index), host: 'export', capture: true, captureSize: output, transparentBackground: output.transparentBackground });
          if (!result.ok || !result.png || result.errors?.length) throw new Error(result.error || result.errors?.join('; ') || `Frame ${index} failed`);
          await fs.writeFile(path.join(destination, `${String(index + 1).padStart(6, '0')}.png`), Buffer.from(result.png.split(',')[1], 'base64'));
        }
        return destination;
      }
      const audio = kind === 'gif' ? { inputs: [] as string[], filter: undefined as string | undefined } : await audioForExport(frozen, frozenRoot, range!);
      const quality = output.quality || 'standard';
      const codec = kind === 'mp4'
        ? ['-c:v', 'libx264', '-crf', String(quality === 'draft' ? 30 : quality === 'high' ? 17 : 23), '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
        : kind === 'webm'
          ? ['-c:v', 'libvpx-vp9', '-crf', String(quality === 'draft' ? 40 : quality === 'high' ? 20 : 30), '-b:v', '0', '-pix_fmt', output.transparentBackground ? 'yuva420p' : 'yuv420p', ...(output.transparentBackground ? ['-auto-alt-ref', '0'] : [])]
          : ['-f', 'gif', '-loop', '0'];
      const encoder = spawn(encoderPath!, [
        '-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(output.fps),
        '-vcodec', 'png', '-i', 'pipe:0', ...audio.inputs,
        ...(audio.filter ? ['-filter_complex', audio.filter, '-map', '0:v', '-map', '[audioout]', '-c:a', kind === 'webm' ? 'libopus' : 'aac', '-b:a', '192k'] : []),
        ...codec, '-t', String((range!.end - range!.start) / frozen.manifest.fps), destination,
      ], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      let inputError: Error | undefined;
      encoder.stdin.on('error', error => { inputError = error; });
      const completion = new Promise<number | null>((resolve, reject) => { encoder.once('error', reject); encoder.once('close', resolve); });
      void completion.catch(() => undefined);
      const cancel = () => encoder.kill();
      signal?.addEventListener('abort', cancel, { once: true });
      encoder.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
      try {
        for (let globalFrame = 0; globalFrame < frames; globalFrame++) {
          signal?.throwIfAborted();
          const result = await waitForRender(window, { requestId: randomUUID(), project: frozen, ...frameAt(globalFrame), host: 'export', capture: true, captureSize: output, transparentBackground: kind === 'webm' && output.transparentBackground });
          if (!result.ok || !result.png || result.errors?.length) throw new Error(result.error || result.errors?.join('; ') || `Frame ${globalFrame} failed`);
          if (inputError) throw inputError;
          if (!encoder.stdin.write(Buffer.from(result.png.split(',')[1], 'base64'))) await Promise.race([once(encoder.stdin, 'drain'), completion.then(() => { throw new Error(`Encoder stopped: ${stderr}`); })]);
          onProgress?.((globalFrame + 1) / frames);
        }
        encoder.stdin.end();
        const code = await completion;
        if (code !== 0) throw new Error(`FFmpeg failed: ${stderr}`);
      } catch (error) {
        encoder.kill();
        throw error;
      } finally { signal?.removeEventListener('abort', cancel); }
    }
    return destination;
  } finally {
    window?.destroy();
    exportRoot = undefined;
    await fs.rm(base, { recursive: true, force: true });
  }
}

app.whenReady().then(async () => {
  ipcMain.on('ai:reply', (event, reply: { id: string; value?: AiSession; error?: string }) => {
    if (event.sender.id !== editor.webContents.id) return;
    const call = editorCalls.get(reply.id);
    if (!call) return;
    clearTimeout(call.timer); editorCalls.delete(reply.id);
    if (reply.error || !reply.value) call.reject(new Error(reply.error || 'Invalid editor reply'));
    else call.resolve(reply.value);
  });
  ipcMain.handle('project:prepare-sources', (_event, project: LoadedProject) => prepareSources(project));
  const qaProjectArg = process.argv.find(arg => arg.startsWith('--ani-qa-project='))?.slice('--ani-qa-project='.length);
  const qaProject = qaProjectArg ? path.resolve(launchDirectory, qaProjectArg) : undefined;
  const qaDefault = process.argv.includes('--ani-qa-default-demo');
  registerProtocols();
  restrictRuntime('ani-runtime');
  const qaLogs: string[] = [];
  const qaMediaRequests = { thumbnails: 0, waveforms: 0 };
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('preload-error', (_errorEvent, preloadPath, error) => qaLogs.push(`preload ${preloadPath}: ${error.message}`));
    contents.on('did-fail-load', (_loadEvent, code, description, url) => qaLogs.push(`load ${url}: ${code} ${description}`));
    contents.on('console-message', (_consoleEvent, ...details) => qaLogs.push(`console ${contents.id}: ${details.map(value => String(value)).join(' | ')}`));
  });
  editor = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1100, minHeight: 700, backgroundColor: '#101920',
    icon: path.join(contentRoot, process.platform === 'win32' ? 'AIS-icon.ico' : 'AIS-icon.png'),
    webPreferences: { preload: path.join(__dirname, 'editor-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true, ...(qaProject || qaDefault ? { backgroundThrottling: false } : {}) },
  });
  editor.webContents.on('will-attach-webview', (event, preferences, params) => {
    if (params.src !== 'app://runtime/runtime.html' || params.partition !== 'ani-runtime') { event.preventDefault(); return; }
    preferences.preload = runtimePreload;
    preferences.nodeIntegration = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
  });
  ipcMain.handle('project:sample', async () => {
    if (qaProject) return setProject(qaProject);
    const bundledSample = path.join(contentRoot, 'examples', 'default-animation');
    try { return await setProject(await prepareDefaultProject(app.getPath('userData'), bundledSample)); }
    catch (error) {
      console.error('Existing sample project could not be loaded:', error);
      const recovered = path.join(app.getPath('userData'), 'default-animation-recovered');
      try { await fs.access(path.join(recovered, 'project.json')); }
      catch { await fs.cp(bundledSample, recovered, { recursive: true, errorOnExist: true, filter: projectCopyFilter(bundledSample) }); }
      try { return await setProject(recovered); } catch { /* First recovery or an invalid earlier copy. */ }
      const fresh = `${recovered}-${Date.now()}`;
      await fs.cp(bundledSample, fresh, { recursive: true, errorOnExist: true, filter: projectCopyFilter(bundledSample) });
      return setProject(fresh);
    }
  });
  ipcMain.handle('project:sample-fresh', async () => {
    const root = path.join(app.getPath('userData'), `sample-project-new-${randomUUID()}`);
    const bundled = path.join(contentRoot, 'examples', 'default-animation');
    await fs.cp(bundled, root, { recursive: true, errorOnExist: true, filter: projectCopyFilter(bundled) });
    return setProject(root);
  });
  ipcMain.handle('project:new', async () => {
    const choice = await dialog.showOpenDialog(editor, { properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled) return undefined;
    await createProject(choice.filePaths[0]);
    return setProject(choice.filePaths[0]);
  });
  ipcMain.handle('project:recent', recentProjects);
  ipcMain.handle('project:open-recent', (_event, root: string) => {
    if (typeof root !== 'string') throw new Error('Invalid project path');
    return setProject(root);
  });
  ipcMain.handle('project:check', (_event, project: LoadedProject) => { assertCurrent(project); return checkProject(project); });
  ipcMain.handle('project:diff', async (_event, project: LoadedProject) => {
    const root = assertCurrent(project);
    return diffProjects(project, await loadProject(root));
  });
  ipcMain.handle('project:history', () => activeRoot ? listHistory(app.getPath('userData'), activeRoot) : []);
  ipcMain.handle('project:snapshot', async (_event, project: LoadedProject) => {
    const root = assertCurrent(project);
    if (await revisionOf(root) !== project.revision) throw new Error('EXTERNAL_CHANGE');
    return saveHistory(app.getPath('userData'), root);
  });
  ipcMain.handle('project:restore', async (_event, id: string) => {
    if (!activeRoot) throw new Error('No project is open');
    const root = activeRoot;
    await saveHistory(app.getPath('userData'), root);
    await restoreHistory(app.getPath('userData'), root, id);
    return setProject(root);
  });
  ipcMain.handle('resource:replace', async (_event, project: LoadedProject, relative: string) => {
    const root = assertCurrent(project);
    if (await revisionOf(root) !== project.revision) throw new Error('EXTERNAL_CHANGE');
    const report = await checkProject(project);
    if (!report.missingAssets.includes(relative)) throw new Error('Resource is not missing');
    const extension = path.extname(relative).slice(1);
    const choice = await dialog.showOpenDialog(editor, {
      title: `Locate ${relative}`,
      properties: ['openFile'],
      filters: extension ? [{ name: `${extension.toUpperCase()} file`, extensions: [extension] }] : undefined,
    });
    if (choice.canceled || !choice.filePaths[0]) return undefined;
    const destination = safeRelative(root, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const parent = await fs.realpath(path.dirname(destination));
    const realRoot = await fs.realpath(root);
    if (path.relative(realRoot, parent).startsWith('..')) throw new Error('Resource directory escapes project');
    const temporary = `${destination}.${process.pid}.tmp`;
    try { await fs.copyFile(choice.filePaths[0], temporary); await fs.rename(temporary, destination); }
    finally { await fs.rm(temporary, { force: true }); }
    loadedRevision = await revisionOf(root);
    return loadedRevision;
  });
  ipcMain.handle('resource:list', async () => activeRoot ? listResourceFiles(activeRoot) : []);
  ipcMain.handle('resource:import', async (_event, project: LoadedProject) => {
    const root = assertCurrent(project);
    if (await revisionOf(root) !== project.revision) throw new Error('EXTERNAL_CHANGE');
    const choice = await dialog.showOpenDialog(editor, { title: 'Import project resources', properties: ['openFile', 'multiSelections'] });
    if (choice.canceled) return undefined;
    const assets: string[] = [];
    for (const source of choice.filePaths) {
      const extension = path.extname(source).toLowerCase();
      const name = path.basename(source, extension).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 80) || 'resource';
      const relative = `assets/${name}-${randomUUID().slice(0, 8)}${extension}`;
      await fs.copyFile(source, safeRelative(root, relative));
      assets.push(relative);
    }
    loadedRevision = await revisionOf(root);
    return { assets, revision: loadedRevision };
  });
  ipcMain.handle('guide:open', (_event, section: 'index' | 'format' | 'legacy' | 'ai' | 'mcp' | 'program' = 'index') => {
    const file = { index: 'README.md', format: 'project-format-v2.zh-CN.md', legacy: 'project-format-v1.md', ai: 'external-ai-workflow.zh-CN.md', mcp: 'mcp-local.zh-CN.md', program: 'project-format-v3.zh-CN.md' }[section];
    if (!file) throw new Error('Unknown documentation section');
    return shell.openPath(path.join(contentRoot, 'docs', file));
  });
  ipcMain.handle('guide:copy-ai-spec', async () => {
    const files = [
      'docs/external-ai-workflow.zh-CN.md',
      'docs/mcp-local.zh-CN.md',
      'docs/project-format-v2.zh-CN.md',
        'docs/project-format-v3.zh-CN.md',
        'docs/ai-creation-phase-3.zh-CN.md',
      'src/sdk/index.ts',
      'docs/project-format-v1.md',
      'schema/project.schema.json',
      'schema/project-v1.schema.json',
      'schema/scene.schema.json',
      'schema/project-v3.schema.json',
      'schema/scene-v3.schema.json',
    ];
    const sections = await Promise.all(files.map(async file => `# ${file}\n\n${await fs.readFile(path.join(contentRoot, file), 'utf8')}`));
    const content = `AIScripter for ani 0.1.0 · 项目格式 v1/v2/v3 · SDK 1.1.0\n\n${sections.join('\n\n---\n\n')}`;
    clipboard.writeText(content);
    return content.length;
  });
  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog(editor, { properties: ['openFile'], filters: [{ name: 'AIScripter project', extensions: ['json'] }] });
    return result.canceled ? undefined : setProject(path.dirname(result.filePaths[0]));
  });
  ipcMain.handle('project:reload', () => activeRoot ? setProject(activeRoot) : undefined);
  ipcMain.handle('project:save', async (_event, project: LoadedProject) => {
    const root = assertCurrent(project);
    if (await revisionOf(root) !== loadedRevision) throw new Error('EXTERNAL_CHANGE');
    const saved = await writeProject(root, project, loadedRevision);
    loadedRevision = saved.revision;
    return saved;
  });
  ipcMain.handle('script:read', (_event, relative: string) => {
    if (!activeRoot || typeof relative !== 'string') throw new Error('No active project script');
    return readScript(activeRoot, relative);
  });
  ipcMain.handle('script:write', async (_event, relative: string, source: string) => {
    if (!activeRoot || typeof relative !== 'string') throw new Error('No active project script');
    if (await revisionOf(activeRoot) !== loadedRevision) throw new Error('EXTERNAL_CHANGE');
    await writeScript(activeRoot, relative, source);
    loadedRevision = await revisionOf(activeRoot);
    return loadedRevision;
  });
  ipcMain.handle('audio:import', async (_event, project: LoadedProject) => {
    const root = assertCurrent(project);
    if (await revisionOf(root) !== loadedRevision) throw new Error('EXTERNAL_CHANGE');
    const choice = await dialog.showOpenDialog(editor, { properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'flac'] }] });
    if (choice.canceled) return undefined;
    const source = choice.filePaths[0];
    const extension = path.extname(source).toLowerCase();
    const executable = ffmpegPath();
    if (!executable) throw new Error('FFmpeg unavailable');
    const probe = spawnSync(executable, ['-hide_banner', '-i', source], { encoding: 'utf8', timeout: 5000 });
    const match = probe.stderr?.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) throw new Error('Unable to read audio duration');
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    const asset = `assets/audio-${randomUUID()}${extension}`;
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.copyFile(source, path.join(root, asset));
    loadedRevision = await revisionOf(root);
    return { asset, revision: loadedRevision, durationFrames: Math.max(1, Math.ceil(seconds * project.manifest.fps)) };
  });
  ipcMain.handle('audio:waveform', (_event, project: LoadedProject, asset: string, width: number, sourceInFrame: number, durationFrames: number) => {
    if (process.argv.includes('--ani-qa-wheel-performance')) qaMediaRequests.waveforms++;
    return waveform(project, asset, width, sourceInFrame, durationFrames);
  });
  ipcMain.handle('scene:thumbnail', (_event, project: LoadedProject, sceneIndex: number, frame: number) => {
    if (process.argv.includes('--ani-qa-wheel-performance')) qaMediaRequests.thumbnails++;
    const task = thumbnailQueue.then(() => thumbnail(project, sceneIndex, frame));
    thumbnailQueue = task.then(() => undefined, () => undefined);
    return task;
  });
  ipcMain.handle('project:save-copy', async (_event, project: LoadedProject) => {
    const root = assertCurrent(project);
    const choice = await dialog.showOpenDialog(editor, { properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled) return undefined;
    const target = path.join(choice.filePaths[0], `${project.manifest.name.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}`);
    await fs.cp(root, target, { recursive: true, errorOnExist: true, filter: projectCopyFilter(root) });
    await writeProject(target, project);
    return setProject(target);
  });
  ipcMain.handle('project:export', (_event, project: LoadedProject, kind: ExportKind, sceneIndex: number, frame: number, options?: ExportOptions) => queuedOutput(() => exportProject(project, kind, sceneIndex, frame, undefined, options)));
  ipcMain.handle('system:ffmpeg', ffmpegAvailable);
  ipcMain.handle('runtime:reset', (event, contentsId: number) => {
    if (event.sender.id !== editor.webContents.id) throw new Error('Untrusted runtime reset');
    const guest = webContents.fromId(contentsId);
    if (guest?.getURL() === 'app://runtime/runtime.html') guest.forcefullyCrashRenderer();
  });
  ipcMain.on('runtime:result', (event, result: RenderResult) => {
    const target = pending.get(result.requestId);
    if (!target || target.senderId !== event.sender.id) return;
    clearTimeout(target.timer);
    pending.delete(result.requestId);
    target.resolve(result);
  });
  await editor.loadURL('app://editor/index.html');
  const screenshotArg = process.argv.find(arg => arg.startsWith('--ani-qa-screenshot='))?.slice('--ani-qa-screenshot='.length);
  const screenshot = screenshotArg ? path.resolve(launchDirectory, screenshotArg) : undefined;
  if (screenshot) {
    setTimeout(async () => {
      try {
        const aiProbe = process.argv.includes('--ani-qa-ai') && activeRoot ? await runAiQa(editor, activeRoot, app.getAppPath(), screenshot) : undefined;
        const programProbe = process.argv.includes('--ani-qa-programs') && activeRoot ? await runProgramQa(editor, activeRoot, app.getAppPath(), screenshot) : undefined;
        const objectEditProbe = process.argv.includes('--ani-qa-object-edit') && activeRoot ? await runObjectEditQa(editor, activeRoot, app.getAppPath(), screenshot) : undefined;
        const defaultDemoProbe = qaDefault && activeRoot ? await runDefaultDemoQa(editor, activeRoot, app.getAppPath(), screenshot) : undefined;
        let timelineProbe: unknown;
        let sequenceProbe: unknown;
        let panZoomProbe: unknown;
        let wheelProbe: unknown;
        if (process.argv.includes('--ani-qa-sequence')) {
          const beforeSceneNames = await editor.webContents.executeJavaScript('Array.from(document.querySelectorAll(".sequence-clip-title"), element => element.textContent?.trim())');
          if (process.argv.includes('--ani-qa-sequence-reorder')) {
            const first = await editor.webContents.executeJavaScript('document.querySelector(".sequence-scene-clip")?.getBoundingClientRect().toJSON()');
            if (!first) throw new Error('First scene clip missing');
            const x = Math.round(first.x + first.width / 2);
            const y = Math.round(first.y + 12);
            editor.webContents.sendInputEvent({ type: 'mouseMove', x, y });
            editor.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y });
            await new Promise(resolve => setTimeout(resolve, 80));
            editor.webContents.sendInputEvent({ type: 'mouseMove', x: x + 160, y, movementX: 160, movementY: 0 });
            await new Promise(resolve => setTimeout(resolve, 80));
            editor.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: x + 160, y });
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          if (process.argv.includes('--ani-qa-playhead-drag')) {
            const ruler = await editor.webContents.executeJavaScript('document.querySelector(".sequence-ruler")?.getBoundingClientRect().toJSON()');
            const firstClip = await editor.webContents.executeJavaScript('document.querySelector(".sequence-scene-clip")?.getBoundingClientRect().toJSON()');
            if (!ruler || !firstClip) throw new Error('Sequence ruler missing');
            const x = Math.round(firstClip.x + 40 * firstClip.width / 35);
            const y = Math.round(ruler.y + ruler.height / 2);
            editor.webContents.sendInputEvent({ type: 'mouseMove', x, y });
            editor.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y });
            editor.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x, y });
            await new Promise(resolve => setTimeout(resolve, 150));
          }
          const beforePlayhead = await editor.webContents.executeJavaScript('document.querySelector(".sequence-playhead")?.getBoundingClientRect().x');
          const beforePlayheadFrame = await editor.webContents.executeJavaScript('document.querySelector(".sequence-playhead")?.getAttribute("aria-valuenow")');
          if (process.argv.includes('--ani-qa-playhead-drag')) {
            const handle = await editor.webContents.executeJavaScript('document.querySelector(".sequence-playhead")?.getBoundingClientRect().toJSON()');
            if (!handle) throw new Error('Global playhead missing');
            const x = Math.round(handle.x + handle.width / 2);
            const y = Math.round(handle.y + Math.min(70, handle.height / 2));
            editor.webContents.sendInputEvent({ type: 'mouseMove', x, y });
            editor.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y });
            await new Promise(resolve => setTimeout(resolve, 80));
            const offset = process.argv.includes('--ani-qa-playhead-left') ? -80 : 40;
            for (let step = 1; step <= 4; step++) {
              editor.webContents.sendInputEvent({ type: 'mouseMove', x: x + offset * step / 4, y, movementX: offset / 4, movementY: 0 });
              await new Promise(resolve => setTimeout(resolve, 40));
            }
            editor.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: x + offset, y });
            await new Promise(resolve => setTimeout(resolve, 400));
          }
          if (process.argv.includes('--ani-qa-sequence-drag')) {
            const handle = await editor.webContents.executeJavaScript('document.querySelector(".sequence-scene-clip .sequence-trim.right")?.getBoundingClientRect().toJSON()');
            if (!handle) throw new Error('Scene trim handle missing');
            const x = Math.round(handle.x + handle.width / 2);
            const y = Math.round(handle.y + handle.height / 2);
            editor.webContents.sendInputEvent({ type: 'mouseMove', x, y });
            editor.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y });
            await new Promise(resolve => setTimeout(resolve, 80));
            editor.webContents.sendInputEvent({ type: 'mouseMove', x: x - 40, y, movementX: -40, movementY: 0 });
            await new Promise(resolve => setTimeout(resolve, 80));
            editor.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: x - 40, y });
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          if (process.argv.includes('--ani-qa-sequence-pan-zoom')) {
            const before = await editor.webContents.executeJavaScript(`(() => {
              const viewport = document.querySelector('.sequence-scroll');
              viewport.scrollLeft = Math.min(100, viewport.scrollWidth - viewport.clientWidth);
              return { scrollLeft: viewport.scrollLeft, clipWidth: document.querySelector('.sequence-scene-clip').getBoundingClientRect().width,
                clipFrames: Number(document.querySelector('.sequence-clip-title small').textContent.match(/\\d+/)[0]),
                playheadFrame: document.querySelector('.sequence-playhead').getAttribute('aria-valuenow'), rect: viewport.getBoundingClientRect().toJSON() };
            })()`);
            const zoomX = Math.round(before.rect.x + before.rect.width / 2);
            const zoomY = Math.round(before.rect.y + 12);
            editor.webContents.debugger.attach('1.3');
            await editor.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: zoomX, y: zoomY, deltaX: 0, deltaY: -120 });
            await new Promise(resolve => setTimeout(resolve, 150));
            const zoomed = await editor.webContents.executeJavaScript(`(() => {
              const viewport = document.querySelector('.sequence-scroll');
              return { scrollLeft: viewport.scrollLeft, clipWidth: document.querySelector('.sequence-scene-clip').getBoundingClientRect().width,
                playheadFrame: document.querySelector('.sequence-playhead').getAttribute('aria-valuenow') };
            })()`);
            if (zoomed.clipWidth <= before.clipWidth) throw new Error('Timeline wheel did not zoom in');
            const offsetX = zoomX - before.rect.x;
            const frameBefore = (before.scrollLeft + offsetX) * before.clipFrames / before.clipWidth;
            const frameAfter = (zoomed.scrollLeft + offsetX) * before.clipFrames / zoomed.clipWidth;
            if (Math.abs(frameAfter - frameBefore) > 1) throw new Error('Timeline zoom did not preserve mouse anchor');
            const panTarget = await editor.webContents.executeJavaScript(`(() => {
              const viewport = document.querySelector('.sequence-scroll');
              viewport.scrollLeft = Math.min(100, viewport.scrollWidth - viewport.clientWidth);
              const rect = viewport.getBoundingClientRect();
              const clip = document.querySelector('.sequence-scene-clip').getBoundingClientRect();
              return { x: Math.round(Math.max(rect.left + 12, Math.min(clip.left + clip.width / 2, rect.right - 12))),
                y: Math.round(clip.top + 12), scrollLeft: viewport.scrollLeft };
            })()`);
            await editor.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panTarget.x, y: panTarget.y });
            await editor.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: panTarget.x, y: panTarget.y, button: 'middle', buttons: 4, clickCount: 1 });
            await new Promise(resolve => setTimeout(resolve, 80));
            await editor.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panTarget.x - 60, y: panTarget.y, button: 'middle', buttons: 4 });
            await new Promise(resolve => setTimeout(resolve, 80));
            await editor.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: panTarget.x - 60, y: panTarget.y, button: 'middle', buttons: 0, clickCount: 1 });
            const panned = await editor.webContents.executeJavaScript(`({ scrollLeft: document.querySelector('.sequence-scroll').scrollLeft,
              playheadFrame: document.querySelector('.sequence-playhead').getAttribute('aria-valuenow'),
              sceneNames: Array.from(document.querySelectorAll('.sequence-clip-title'), element => element.textContent?.trim()) })`);
            if (panned.scrollLeft <= panTarget.scrollLeft + 20) throw new Error(`Middle-drag did not pan timeline: ${JSON.stringify({ panTarget, panned })}`);
            if (panned.playheadFrame !== before.playheadFrame) throw new Error('Middle-drag changed playhead frame');
            await editor.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: zoomX, y: zoomY, deltaX: 0, deltaY: 120 });
            await new Promise(resolve => setTimeout(resolve, 150));
            editor.webContents.debugger.detach();
            const zoomedOut = await editor.webContents.executeJavaScript('document.querySelector(".sequence-scene-clip").getBoundingClientRect().width');
            if (Math.abs(zoomedOut - before.clipWidth) > 1) throw new Error('Timeline wheel did not zoom back out');
            panZoomProbe = { before, zoomed, panTarget, panned, zoomedOut };
          }
          sequenceProbe = await editor.webContents.executeJavaScript(`({
            sceneClips: document.querySelectorAll('.sequence-scene-clip').length,
            audioClips: document.querySelectorAll('.sequence-audio-clip').length,
            thumbnails: document.querySelectorAll('.sequence-clip-images img[src^="data:image/png"]').length,
            waveforms: document.querySelectorAll('.sequence-audio-clip img[src^="data:image/png"]').length,
            playhead: document.querySelector('.sequence-playhead')?.getBoundingClientRect().toJSON(),
            firstClip: document.querySelector('.sequence-scene-clip')?.getBoundingClientRect().toJSON(),
            secondClip: document.querySelectorAll('.sequence-scene-clip')[1]?.getBoundingClientRect().toJSON(),
            trackName: document.querySelector('.sequence-label-audio')?.textContent,
            sceneNames: Array.from(document.querySelectorAll('.sequence-clip-title'), element => element.textContent?.trim()),
            timelineMode: document.querySelector('.timeline-tabs .active')?.textContent,
            playheadFrame: document.querySelector('.sequence-playhead')?.getAttribute('aria-valuenow'),
            previewScene: document.querySelector('.canvas-scene')?.textContent
          })`);
          (sequenceProbe as Record<string, unknown>).beforePlayhead = beforePlayhead;
          (sequenceProbe as Record<string, unknown>).beforePlayheadFrame = beforePlayheadFrame;
          (sequenceProbe as Record<string, unknown>).beforeSceneNames = beforeSceneNames;
        }
        if (process.argv.includes('--ani-qa-wheel-performance')) {
          const beforeRequests = { ...qaMediaRequests };
          const burst = await editor.webContents.executeJavaScript(`(async () => {
            const viewport = document.querySelector('.sequence-scroll');
            const content = document.querySelector('.sequence-scene-clip');
            const rect = viewport.getBoundingClientRect();
            let mutations = 0;
            const observer = new MutationObserver(records => { mutations += records.length; });
            observer.observe(content, { attributes: true, attributeFilter: ['style'] });
            const before = content.style.width;
            for (let i = 0; i < 120; i++) viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, clientX: rect.left + 150, cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 120));
            observer.disconnect();
            return { events: 120, layoutCommits: mutations, before, after: content.style.width };
          })()`);
          if (burst.layoutCommits > 2 || burst.before === burst.after) throw new Error(`Wheel burst was not batched: ${JSON.stringify(burst)}`);
          const samples = [];
          for (const delta of [-600, 600]) {
            await editor.webContents.executeJavaScript(`(() => {
              const viewport = document.querySelector('.sequence-scroll');
              const rect = viewport.getBoundingClientRect();
              for (let i = 0; i < 12; i++) viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: ${delta}, clientX: rect.left + 100, cancelable: true }));
            })()`);
            await new Promise(resolve => setTimeout(resolve, 200));
            const sample = await editor.webContents.executeJavaScript(`(() => {
              const labels = Array.from(document.querySelectorAll('.sequence-ruler span'), element => ({ label: element.textContent, rect: element.getBoundingClientRect().toJSON() }));
              return { clipWidth: document.querySelector('.sequence-scene-clip').getBoundingClientRect().width, labels,
                overlaps: labels.slice(1).filter((value, index) => labels[index].rect.right > value.rect.left).length,
                thumbnailCells: document.querySelectorAll('.sequence-thumbnail-cell').length };
            })()`);
            if (sample.overlaps || sample.labels.length > 30 || sample.thumbnailCells !== 8) throw new Error('Timeline density is unbounded or labels overlap');
            samples.push(sample);
          }
          const extraRequests = { thumbnails: qaMediaRequests.thumbnails - beforeRequests.thumbnails, waveforms: qaMediaRequests.waveforms - beforeRequests.waveforms };
          if (extraRequests.thumbnails || extraRequests.waveforms) throw new Error('Zoom regenerated timeline media');
          wheelProbe = { burst, samples, extraRequests };
        }
        if (process.argv.includes('--ani-qa-timeline') || process.argv.includes('--ani-qa-timeline-move')) {
          const moving = process.argv.includes('--ani-qa-timeline-move');
          const handle = await editor.webContents.executeJavaScript(`document.querySelector("${moving ? '.track-row .track-bar' : '.track-row .trim-handle.end'}")?.getBoundingClientRect().toJSON()`);
          if (!handle) throw new Error('Timeline trim handle missing');
          const x = Math.round(handle.x + handle.width / 2);
          const y = Math.round(handle.y + handle.height / 2);
          const offset = moving ? 100 : -100;
          editor.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          editor.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y });
          await new Promise(resolve => setTimeout(resolve, 80));
          editor.webContents.sendInputEvent({ type: 'mouseMove', x: x + offset, y, movementX: offset, movementY: 0 });
          await new Promise(resolve => setTimeout(resolve, 80));
          editor.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: x + offset, y });
          await new Promise(resolve => setTimeout(resolve, 3000));
          timelineProbe = await editor.webContents.executeJavaScript('({ startValue: document.querySelectorAll(".inspector section:first-child input")[1]?.value, endValue: document.querySelectorAll(".inspector section:first-child input")[2]?.value, selected: document.querySelector(".layer-item.selected")?.textContent })');
        }
        let curveProbe: unknown;
        if (process.argv.includes('--ani-qa-curve') || process.argv.includes('--ani-qa-curve-drag')) {
          await editor.webContents.executeJavaScript('document.querySelector(".key-diamond")?.click()');
          await new Promise(resolve => setTimeout(resolve, 500));
          if (process.argv.includes('--ani-qa-curve-drag')) {
            const handle = await editor.webContents.executeJavaScript('document.querySelector(".curve-handle")?.getBoundingClientRect().toJSON()');
            if (!handle) throw new Error('Easing curve handle missing');
            const x = Math.round(handle.x + handle.width / 2);
            const y = Math.round(handle.y + handle.height / 2);
            editor.webContents.sendInputEvent({ type: 'mouseMove', x, y });
            editor.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y });
            await new Promise(resolve => setTimeout(resolve, 80));
            editor.webContents.sendInputEvent({ type: 'mouseMove', x: x + 65, y: y - 45, movementX: 65, movementY: -45 });
            await new Promise(resolve => setTimeout(resolve, 80));
            editor.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: x + 65, y: y - 45 });
            await new Promise(resolve => setTimeout(resolve, 3000));
            curveProbe = await editor.webContents.executeJavaScript('Array.from(document.querySelectorAll(".curve-values input"), input => input.value)');
          } else await new Promise(resolve => setTimeout(resolve, 1000));
        }
        let keyBatchProbe: unknown;
        if (process.argv.includes('--ani-qa-key-batch')) {
          await editor.webContents.executeJavaScript('document.querySelectorAll(".timeline-tabs button")[1]?.click()');
          await new Promise(resolve => setTimeout(resolve, 200));
          keyBatchProbe = await editor.webContents.executeJavaScript(`(() => {
            const row = Array.from(document.querySelectorAll('.track-row')).find(item => item.querySelectorAll('.key-diamond').length >= 2);
            const keys = row?.querySelectorAll('.key-diamond');
            if (!keys || keys.length < 2) throw new Error('Keyframe fixture missing');
            keys[0].click();
            keys[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
            return { before: document.querySelectorAll('.track-row .key-diamond').length };
          })()`);
          await new Promise(resolve => setTimeout(resolve, 100));
          const selected = await editor.webContents.executeJavaScript('document.querySelector(".key-selection-actions span")?.textContent');
          if (selected !== '已选 2 个关键帧') throw new Error(`Keyframe multi-selection failed: ${selected}`);
          await editor.webContents.executeJavaScript('document.querySelectorAll(".key-selection-actions button")[0]?.click()');
          await new Promise(resolve => setTimeout(resolve, 100));
          await editor.webContents.executeJavaScript('document.querySelectorAll(".key-selection-actions button")[1]?.click()');
          await new Promise(resolve => setTimeout(resolve, 200));
          const after = await editor.webContents.executeJavaScript('document.querySelectorAll(".track-row .key-diamond").length');
          if (after <= (keyBatchProbe as { before: number }).before) throw new Error('Pasting keyframes did not add a key');
          keyBatchProbe = { ...(keyBatchProbe as object), selected, after, actions: await editor.webContents.executeJavaScript('document.querySelector(".key-selection-actions")?.textContent') };
        }
        let flickerProbe: unknown;
        if (process.argv.includes('--ani-qa-flicker')) {
          const guestId = await editor.webContents.executeJavaScript('document.querySelector("webview")?.getWebContentsId()');
          const guest = guestId ? webContents.fromId(guestId) : undefined;
          if (!guest) throw new Error('Preview renderer missing');
          await editor.webContents.executeJavaScript('document.querySelector(".play-button")?.click()');
          const samples: number[][] = [];
          for (let index = 0; index < 50; index++) {
            const pixel = await guest.executeJavaScript('Array.from(document.querySelector("canvas").getContext("2d").getImageData(250, 550, 1, 1).data)') as number[];
            samples.push(pixel);
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          await editor.webContents.executeJavaScript('document.querySelector(".play-button")?.click()');
          flickerProbe = { samples: samples.length, darkFrames: samples.filter(([red, green]) => red < 160 || green < 90).length };
        }
        let expressionProbe: unknown;
        if (process.argv.includes('--ani-qa-expression')) {
          await editor.webContents.executeJavaScript(`(() => {
            const input = document.querySelector('.expression-editor input');
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (!input || !setter) throw new Error('Expression input missing');
            setter.call(input, 'base + 10 * sin(time)');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          })()`);
          await new Promise(resolve => setTimeout(resolve, 100));
          expressionProbe = await editor.webContents.executeJavaScript(`(() => {
            const button = document.querySelector('.expression-footer button');
            const before = { buttonDisabled: button?.disabled, value: document.querySelector('.expression-editor input')?.value };
            button?.click();
            return before;
          })()`);
          await new Promise(resolve => setTimeout(resolve, 100));
          const applied = await editor.webContents.executeJavaScript(`({ buttonDisabled: document.querySelector('.expression-footer button')?.disabled,
            value: document.querySelector('.expression-editor input')?.value, error: document.querySelector('.expression-error')?.textContent })`);
          expressionProbe = { before: expressionProbe, applied };
        }
        let docsProbe: string[] | undefined;
        if (process.argv.includes('--ani-qa-docs-menu')) {
          await editor.webContents.executeJavaScript('document.querySelector(".project-trigger")?.click()');
          await editor.webContents.executeJavaScript('Array.from(document.querySelectorAll(".project-popover [role=menuitem]")).find(element => element.textContent?.includes("项目文档与 AI 规范"))?.click()');
          docsProbe = await editor.webContents.executeJavaScript('Array.from(document.querySelectorAll(".docs-dialog .docs-list button strong"), element => element.textContent?.trim())');
          if (!docsProbe?.includes('项目文档首页') || !docsProbe.includes('v2 工程格式') || !docsProbe.includes('外部 AI 创作规范') || !docsProbe.includes('本机 MCP 接入') || !docsProbe.includes('复制规范给外部 AI')) throw new Error('Documentation entries missing from project menu');
        }
        let freshSampleProbe: unknown;
        if (process.argv.includes('--ani-qa-fresh-sample')) {
          const beforeRoot = await editor.webContents.executeJavaScript('document.querySelector(".project-trigger")?.title');
          await editor.webContents.executeJavaScript('document.querySelector(".project-trigger")?.click()');
          await editor.webContents.executeJavaScript('Array.from(document.querySelectorAll(".project-popover [role=menuitem]")).find(element => element.textContent?.includes("打开新版示例工程"))?.click()');
          await new Promise(resolve => setTimeout(resolve, 800));
          freshSampleProbe = await editor.webContents.executeJavaScript(`({ root: document.querySelector('.project-trigger')?.title,
            secondScene: document.querySelectorAll('.scene-item .scene-meta small')[1]?.textContent,
            status: document.querySelector('.status-message')?.textContent })`);
          if (!(freshSampleProbe as { root?: string }).root?.includes('sample-project-new-') || (freshSampleProbe as { root?: string }).root === beforeRoot
            || !(freshSampleProbe as { secondScene?: string }).secondScene?.includes('2 个图层')) throw new Error(`Fresh sample did not open: ${JSON.stringify(freshSampleProbe)}`);
        }
        const state = await editor.webContents.executeJavaScript('({url: location.href, title: document.title, hasAni: !!window.ani, status: document.querySelector(".status-message")?.textContent, selectedLayer: document.querySelector(".layer-item.selected")?.textContent, inspectorEnd: document.querySelectorAll(".inspector section:first-child input")[2]?.value, firstBar: document.querySelector(".track-row .track-bar")?.getBoundingClientRect().toJSON(), stage: document.querySelector(".stage-frame")?.getBoundingClientRect().toJSON(), webview: document.querySelector("webview")?.getBoundingClientRect().toJSON()})');
        const guestId = await editor.webContents.executeJavaScript('document.querySelector("webview")?.getWebContentsId()');
        const guest = guestId ? webContents.fromId(guestId) : undefined;
        const guestState = guest ? await Promise.race([
          guest.executeJavaScript('({width: innerWidth, height: innerHeight, canvas: document.querySelector("canvas").getBoundingClientRect().toJSON(), stageWidth: document.querySelector("canvas").width, pngLength: document.querySelector("canvas").toDataURL().length})'),
          new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 2000)),
        ]) : null;
        const probe = guest ? await guest.executeJavaScript(`(async () => {
          async function canFetch(url) { try { return (await fetch(url)).ok; } catch { return false; } }
          return { projectAsset: await canFetch('project://active/assets/palette.json'),
            network: await canFetch('https://example.com/'), outsideFile: await canFetch('file:///C:/Windows/win.ini'), privateMetadata: await canFetch('project://active/.aiscripter/mcp-session.json'),
            nodeAvailable: typeof window.require === 'function' };
        })()`) : null;
        await fs.writeFile(`${screenshot}.json`, JSON.stringify({ state, guestState, probe, aiProbe, programProbe, objectEditProbe, defaultDemoProbe, sequenceProbe, panZoomProbe, wheelProbe, timelineProbe, curveProbe, keyBatchProbe, flickerProbe, expressionProbe, docsProbe, freshSampleProbe, distRoot, qaLogs }, null, 2));
        let capture;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { editor.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 150)); capture = await editor.webContents.capturePage(undefined, { stayAwake: true, stayHidden: true }); break; }
          catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
        }
        await fs.writeFile(screenshot, capture!.toPNG());
      } catch (error) { await fs.writeFile(`${screenshot}.error.txt`, String(error)); }
      finally { app.quit(); }
    }, qaProject || qaDefault ? 13000 : 5000);
  }
  const qaExportArg = process.argv.find(arg => arg.startsWith('--ani-qa-export='))?.slice('--ani-qa-export='.length);
  const qaExport = qaExportArg ? path.resolve(launchDirectory, qaExportArg) : undefined;
  if (qaExport) {
    setTimeout(async () => {
      try {
        const project = await setProject(qaProject || path.join(contentRoot, 'examples', 'solar-system'));
        const kind: ExportKind = qaExport.toLowerCase().endsWith('.mp4') ? 'mp4' : qaExport.toLowerCase().endsWith('.webm') ? 'webm' : qaExport.toLowerCase().endsWith('.gif') ? 'gif' : qaExport.toLowerCase().endsWith('.frames') ? 'sequence' : 'png';
        const qaSize = process.argv.find(arg => arg.startsWith('--ani-qa-output='))?.slice('--ani-qa-output='.length).match(/^(\d+)x(\d+)@(\d+)$/);
        const qaRange = process.argv.find(arg => arg.startsWith('--ani-qa-range='))?.slice('--ani-qa-range='.length).match(/^(\d+):(\d+)$/);
        const options: ExportOptions | undefined = qaSize ? { width: Number(qaSize[1]), height: Number(qaSize[2]), fps: Number(qaSize[3]), transparentBackground: process.argv.includes('--ani-qa-transparent'), ...(qaRange ? { scope: 'range', startFrame: Number(qaRange[1]), endFrame: Number(qaRange[2]) } as const : {}) } : undefined;
        const qaFrame = Number(process.argv.find(arg => arg.startsWith('--ani-qa-frame='))?.slice('--ani-qa-frame='.length) ?? 37);
        const position = process.argv.includes('--ani-qa-global-frame') ? sceneAtFrame(project.scenes, qaFrame) : { sceneIndex: 0, frame: qaFrame };
        const output = await exportProject(project, kind, position.sceneIndex, position.frame, qaExport, options);
        await fs.writeFile(`${qaExport}.json`, JSON.stringify({ output, qaLogs }, null, 2));
      } catch (error) { await fs.writeFile(`${qaExport}.error.txt`, String(error)); }
      finally { app.quit(); }
    }, 1000);
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) app.quit(); });
});

app.on('window-all-closed', () => app.quit());

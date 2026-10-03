import type { Layer, LoadedProject, RenderCommand, RenderResult } from '../shared/types';
import { valueAt } from '../shared/animation';
import { cancelProgramWork, renderProgram } from './program-pool';

declare global {
  interface Window {
    runtimeHost: {
      onCommand: (callback: (command: RenderCommand) => void) => void;
      result: (result: RenderResult) => void;
      progress: (progress: { requestId: string; layerId: string }) => void;
    };
  }
}

const stage = document.getElementById('stage') as HTMLCanvasElement;
const context = stage.getContext('2d')!;
const frameSurface = document.createElement('canvas');
const frameContext = frameSurface.getContext('2d')!;
const imageCache = new Map<string, Promise<HTMLImageElement>>();
const videoCache = new Map<string, Promise<HTMLVideoElement>>();
const dataCache = new Map<string, Promise<unknown>>();

function projectUrl(host: string, relative: string, revision: string, prefix = ''): string {
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`Invalid project path: ${relative}`);
  }
  return `project://${host}/${prefix}${relative.split('/').map(encodeURIComponent).join('/')}?revision=${encodeURIComponent(revision)}`;
}

function imageFor(url: string): Promise<HTMLImageElement> {
  let found = imageCache.get(url);
  if (!found) {
    found = new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Missing image: ${url}`));
      image.src = url;
    });
    imageCache.set(url, found);
  }
  return found;
}

function dataFor(url: string): Promise<unknown> {
  let found = dataCache.get(url);
  if (!found) {
    found = fetch(url).then(async response => {
      if (!response.ok) throw new Error(`Unable to read data: ${url}`);
      const source = await response.text();
      if (source.length > 1024 * 1024) throw new Error('Data file exceeds the 1 MB limit');
      return JSON.parse(source) as unknown;
    });
    dataCache.set(url, found);
  }
  return found;
}

async function boundLayer(layer: Layer, command: RenderCommand): Promise<Layer> {
  if (!layer.bindings || !Object.keys(layer.bindings).length) return layer;
  const copy: Layer = { ...layer, params: { ...layer.params } };
  for (const [property, binding] of Object.entries(layer.bindings)) {
    let current = await dataFor(projectUrl(command.host, binding.asset, command.project.revision, command.project.resourcePrefix));
    for (const part of binding.path.split('.')) {
      if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) throw new Error(`Missing data value: ${binding.path}`);
      current = (current as Record<string, unknown>)[part];
    }
    const expected = property.startsWith('params.') ? typeof layer.params?.[property.slice(7)] : ['text', 'color'].includes(property) ? 'string' : 'number';
    if (typeof current !== expected || (typeof current === 'number' && !Number.isFinite(current))) throw new Error(`Data type mismatch: ${property}`);
    if (property.startsWith('params.')) copy.params![property.slice(7)] = current as number | string | boolean;
    else (copy as unknown as Record<string, unknown>)[property] = current;
  }
  return copy;
}

function videoFor(url: string): Promise<HTMLVideoElement> {
  let found = videoCache.get(url);
  if (!found) {
    found = new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous'; video.preload = 'auto'; video.muted = true;
      video.onloadeddata = () => resolve(video);
      video.onerror = () => reject(new Error(`Missing or unsupported video: ${url}`));
      video.src = url;
    });
    videoCache.set(url, found);
  }
  return found;
}

async function videoAt(url: string, seconds: number): Promise<HTMLVideoElement> {
  const video = await videoFor(url);
  const target = Math.max(0, Math.min(Math.max(0, video.duration - 0.001), seconds));
  if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) return video;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('Video seek timed out')); }, 8000);
    const cleanup = () => { window.clearTimeout(timer); video.removeEventListener('seeked', ready); video.removeEventListener('error', failed); };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Video seek failed')); };
    video.addEventListener('seeked', ready, { once: true });
    video.addEventListener('error', failed, { once: true });
    video.currentTime = target;
  });
  return video;
}

function drawMedia(local: CanvasRenderingContext2D, source: CanvasImageSource, sourceWidth: number, sourceHeight: number, layer: Layer, width: number, height: number): void {
  const crop = layer.crop || { x: 0, y: 0, width: 1, height: 1 };
  const sx = Math.round(crop.x * sourceWidth);
  const sy = Math.round(crop.y * sourceHeight);
  const sw = Math.max(1, Math.min(sourceWidth - sx, Math.round(crop.width * sourceWidth)));
  const sh = Math.max(1, Math.min(sourceHeight - sy, Math.round(crop.height * sourceHeight)));
  const fit = layer.mediaFit || 'stretch';
  if (fit === 'stretch') { local.drawImage(source, sx, sy, sw, sh, 0, 0, width, height); return; }
  const scale = fit === 'contain' ? Math.min(width / sw, height / sh) : Math.max(width / sw, height / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  local.drawImage(source, sx, sy, sw, sh, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

function frameSeed(layerId: string, frame: number): number {
  let hash = (2166136261 ^ frame) >>> 0;
  for (const character of layerId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash || 1;
}

async function renderCustom(layer: Layer, command: RenderCommand): Promise<ImageBitmap> {
  const worker = new Worker(new URL('./custom-worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<ImageBitmap>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Script exceeded the 8 second frame limit')), 8000);
      worker.onmessage = (event: MessageEvent<{ ok: true; bitmap: ImageBitmap } | { ok: false; error: string; stack?: string }>) => {
        window.clearTimeout(timer);
        if (event.data.ok) resolve(event.data.bitmap);
        else { const error = new Error(event.data.error); if (event.data.stack) error.stack = event.data.stack; reject(error); }
      };
      worker.onerror = event => {
        window.clearTimeout(timer);
        reject(new Error(event.message || 'Script worker crashed'));
      };
      worker.postMessage({
        scriptUrl: projectUrl(command.host, layer.script!, command.project.revision, command.project.resourcePrefix),
        resourcePrefix: command.project.resourcePrefix,
        host: command.host, revision: command.project.revision, renderer: layer.renderer || '2d',
        width: layer.width, height: layer.height, frame: command.frame, fps: command.project.manifest.fps,
        params: paramsAt(layer, command.frame, command.project.manifest.fps), seed: frameSeed(layer.id, command.frame),
      });
    });
  } finally { worker.terminate(); }
}

function numeric(layer: Layer, property: string, frame: number, fps: number): number {
  const value = valueAt(layer, property, frame, fps);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function paramsAt(layer: Layer, frame: number, fps: number): Record<string, unknown> {
  const params: Record<string, unknown> = { ...layer.params };
  for (const property of new Set([...Object.keys(layer.keyframes), ...Object.keys(layer.expressions || {})])) {
    if (property.startsWith('params.')) params[property.slice(7)] = valueAt(layer, property, frame, fps);
  }
  return params;
}

async function drawLayer(layer: Layer, command: RenderCommand, target: CanvasRenderingContext2D, surface: HTMLCanvasElement): Promise<void> {
  const { project, frame, host } = command;
  const fps = project.manifest.fps;
  if (!layer.visible || frame < layer.startFrame || frame >= layer.endFrame) return;
  if (layer.type === 'audio') return;
  layer = await boundLayer(layer, command);
  const width = Math.ceil(layer.width);
  const height = Math.ceil(layer.height);
  surface.width = width; surface.height = height;
  const local = surface.getContext('2d')!;
  target.save();
  try {
    local.shadowColor = layer.shadowColor || 'transparent';
    local.shadowBlur = layer.shadowBlur || 0;
    if (layer.type === 'text') {
      local.fillStyle = String(valueAt(layer, 'color', frame, fps) || '#ffffff');
      local.textAlign = layer.textAlign || 'center';
      local.textBaseline = 'middle';
      local.font = `${layer.fontWeight || 400} ${layer.fontSize || 64}px ${layer.fontFamily || 'Arial'}`;
      local.letterSpacing = `${layer.letterSpacing || 0}px`;
      const lines = String(valueAt(layer, 'text', frame, fps) || '').split('\n');
      const lineHeight = (layer.fontSize || 64) * (layer.lineHeight || 1.2);
      const x = local.textAlign === 'left' ? 0 : local.textAlign === 'right' ? width : width / 2;
      for (let i = 0; i < lines.length; i++) {
        const y = height / 2 + (i - (lines.length - 1) / 2) * lineHeight;
        if (layer.textStrokeWidth) { local.strokeStyle = layer.textStrokeColor || '#000000'; local.lineWidth = layer.textStrokeWidth; local.strokeText(lines[i], x, y, width); }
        local.fillText(lines[i], x, y, width);
      }
    } else if (layer.type === 'shape') {
      local.fillStyle = String(valueAt(layer, 'color', frame, fps) || '#ffffff');
      local.strokeStyle = layer.strokeColor || '#ffffff';
      local.lineWidth = layer.strokeWidth || 0;
      local.beginPath();
      if (layer.shape === 'ellipse') {
        local.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      } else if (layer.shape === 'line') {
        local.moveTo(0, height);
        local.lineTo(width, 0);
      } else if (layer.shape === 'polygon') {
        const sides = Math.max(3, Math.min(64, layer.sides || 5));
        for (let index = 0; index < sides; index++) {
          const angle = -Math.PI / 2 + index * Math.PI * 2 / sides;
          const x = width / 2 + Math.cos(angle) * width / 2;
          const y = height / 2 + Math.sin(angle) * height / 2;
          if (index === 0) local.moveTo(x, y); else local.lineTo(x, y);
        }
        local.closePath();
      } else if (layer.shape === 'path' && layer.pathData) {
        const path = new Path2D(layer.pathData);
        local.fill(path);
        if (layer.strokeWidth) local.stroke(path);
      } else local.roundRect(0, 0, width, height, Math.min(layer.cornerRadius || 0, width / 2, height / 2));
      if (layer.shape !== 'path') {
        if (layer.shape !== 'line') local.fill();
        if (layer.strokeWidth || layer.shape === 'line') { if (layer.shape === 'line' && !layer.strokeWidth) local.lineWidth = 2; local.stroke(); }
      }
    } else if ((layer.type === 'image' || layer.type === 'svg') && layer.asset) {
      const image = await imageFor(projectUrl(host, layer.asset, project.revision, project.resourcePrefix));
      drawMedia(local, image, image.naturalWidth, image.naturalHeight, layer, width, height);
    } else if (layer.type === 'video' && layer.asset) {
      const video = await videoAt(projectUrl(host, layer.asset, project.revision, project.resourcePrefix), ((frame - layer.startFrame) * (layer.playbackRate || 1) + (layer.mediaInFrame || 0)) / project.manifest.fps);
      drawMedia(local, video, video.videoWidth, video.videoHeight, layer, width, height);
    } else if (layer.type === 'model3d' && layer.asset) {
      const { renderModel3d } = await import('./model3d');
      const modelCanvas = await renderModel3d(layer, projectUrl(host, layer.asset, project.revision, project.resourcePrefix), frame, project.manifest.fps);
      local.drawImage(modelCanvas, 0, 0, width, height);
    } else if (layer.type === 'custom' && layer.script) {
      const bitmap = await renderCustom(layer, command);
      try { local.drawImage(bitmap, 0, 0, width, height); }
      finally { bitmap.close(); }
    }
    if (layer.mask) {
      const mask = await imageFor(projectUrl(host, layer.mask, project.revision, project.resourcePrefix));
      local.globalCompositeOperation = 'destination-in';
      local.drawImage(mask, 0, 0, width, height);
      local.globalCompositeOperation = 'source-over';
    }
    target.globalAlpha = Math.max(0, Math.min(1, numeric(layer, 'opacity', frame, fps)));
    target.globalCompositeOperation = layer.blendMode === 'add' ? 'lighter' : layer.blendMode && layer.blendMode !== 'normal' ? layer.blendMode : 'source-over';
    const blur = Math.max(0, Number(valueAt(layer, 'blur', frame, fps) ?? 0));
    const brightness = Math.max(0, Number(valueAt(layer, 'brightness', frame, fps) ?? 1));
    const saturation = Math.max(0, Number(valueAt(layer, 'saturation', frame, fps) ?? 1));
    target.filter = `blur(${blur}px) brightness(${brightness}) saturate(${saturation})`;
    target.translate(numeric(layer, 'x', frame, fps), numeric(layer, 'y', frame, fps));
    target.rotate(numeric(layer, 'rotation', frame, fps) * Math.PI / 180);
    target.scale(numeric(layer, 'scaleX', frame, fps), numeric(layer, 'scaleY', frame, fps));
    target.drawImage(surface, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
  } finally {
    target.restore();
  }
}

let latestPreviewRequest = '';
async function render(command: RenderCommand): Promise<RenderResult> {
  const errors: string[] = [];
  const diagnostics: NonNullable<RenderResult['diagnostics']> = [];
  let programStats: RenderResult['programStats'];
  let programEdit: RenderResult['programEdit'];
  const { project, sceneIndex, frame } = command;
  const scene = project.scenes[sceneIndex];
  if (!scene) throw new Error('Scene does not exist');
  const layerSurface = document.createElement('canvas');
  if (frameSurface.width !== project.manifest.width || frameSurface.height !== project.manifest.height) {
    frameSurface.width = project.manifest.width;
    frameSurface.height = project.manifest.height;
  }
  frameContext.clearRect(0, 0, frameSurface.width, frameSurface.height);
  if (!command.transparentBackground) {
    frameContext.fillStyle = '#101a2b';
    frameContext.fillRect(0, 0, frameSurface.width, frameSurface.height);
  }
  if (scene.program) {
    try {
      window.runtimeHost.progress({ requestId: command.requestId, layerId: scene.id });
      const result = await renderProgram(command);
      try { frameContext.drawImage(result.bitmap, 0, 0); programStats = result.stats; programEdit = result.edit; }
      finally { result.bitmap.close(); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${scene.name}: ${message}`);
      diagnostics.push({ sceneId: scene.id, layerId: scene.id, path: scene.program.entry, frame, message, stack: error instanceof Error ? error.stack?.slice(0, 4000) : undefined });
      frameContext.fillStyle = '#852739'; frameContext.fillRect(24, 24, 560, 64);
      frameContext.fillStyle = '#ffffff'; frameContext.font = '24px Arial'; frameContext.fillText('Program scene error - see diagnostics', 40, 65);
    }
  }
  for (const layer of scene.layers) {
    try {
      if (command.disabledLayerIds?.includes(layer.id)) throw new Error('Script timed out; edit or reload the script to retry');
      window.runtimeHost.progress({ requestId: command.requestId, layerId: layer.id });
      await drawLayer(layer, command, frameContext, layerSurface);
    }
    catch (error) {
      errors.push(`${layer.name}: ${error instanceof Error ? error.message : String(error)}`);
      diagnostics.push({ sceneId: scene.id, layerId: layer.id, path: layer.script || layer.asset, frame, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack?.slice(0, 4000) : undefined });
      frameContext.save();
      frameContext.fillStyle = 'rgba(180,45,60,.8)';
      frameContext.fillRect(layer.x - 60, layer.y - 20, 120, 40);
      frameContext.fillStyle = '#ffffff';
      frameContext.font = '18px Arial';
      frameContext.textAlign = 'center';
      frameContext.fillText('Layer error', layer.x, layer.y + 6);
      frameContext.restore();
    }
  }
  if (command.host === 'active' && !command.capture && command.requestId !== latestPreviewRequest) return { requestId: command.requestId, ok: true, errors, diagnostics, programStats };
  if (stage.width !== frameSurface.width || stage.height !== frameSurface.height) {
    stage.width = frameSurface.width;
    stage.height = frameSurface.height;
  }
  context.globalCompositeOperation = 'copy';
  context.drawImage(frameSurface, 0, 0);
  context.globalCompositeOperation = 'source-over';
  let png: string | undefined;
  if (command.capture) {
    const size = command.captureSize;
    if (size && (size.width !== stage.width || size.height !== stage.height)) {
      const scaled = document.createElement('canvas');
      scaled.width = size.width;
      scaled.height = size.height;
      scaled.getContext('2d')!.drawImage(stage, 0, 0, size.width, size.height);
      png = scaled.toDataURL('image/png');
    } else png = stage.toDataURL('image/png');
  }
  return { requestId: command.requestId, ok: true, errors, diagnostics, programStats, programEdit, png };
}

let renderQueue = Promise.resolve();
window.runtimeHost.onCommand(command => {
  if (command.host === 'active' && !command.capture) {
    latestPreviewRequest = command.requestId;
    cancelProgramWork();
  }
  renderQueue = renderQueue.then(async () => {
    if (command.host === 'active' && !command.capture && command.requestId !== latestPreviewRequest) {
      window.runtimeHost.result({ requestId: command.requestId, ok: true }); return;
    }
    try { window.runtimeHost.result(await render(command)); }
    catch (error) { window.runtimeHost.result({ requestId: command.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  });
});

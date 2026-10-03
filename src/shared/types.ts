import type { ProgramEdits, ProgramFeedback } from '../sdk';
export type KeyframeValue = number | string;
export type EasingCurve = [number, number, number, number];
export type Keyframe = { frame: number; value: KeyframeValue; easing?: EasingCurve };
export type LayerType = 'text' | 'shape' | 'image' | 'svg' | 'video' | 'audio' | 'model3d' | 'custom';
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'difference' | 'add';

export interface Layer {
  id: string;
  name: string;
  type: LayerType;
  startFrame: number;
  endFrame: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked?: boolean;
  keyframes: Record<string, Keyframe[]>;
  expressions?: Record<string, string>;
  bindings?: Record<string, { asset: string; path: string }>;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: 'left' | 'center' | 'right';
  textStrokeColor?: string;
  textStrokeWidth?: number;
  color?: string;
  shape?: 'rect' | 'ellipse' | 'line' | 'polygon' | 'path';
  sides?: number;
  pathData?: string;
  strokeColor?: string;
  strokeWidth?: number;
  cornerRadius?: number;
  shadowColor?: string;
  shadowBlur?: number;
  asset?: string;
  mediaFit?: 'stretch' | 'contain' | 'cover';
  crop?: { x: number; y: number; width: number; height: number };
  playbackRate?: number;
  mediaInFrame?: number;
  mask?: string;
  blendMode?: BlendMode;
  blur?: number;
  brightness?: number;
  saturation?: number;
  volume?: number;
  muted?: boolean;
  loop?: boolean;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  modelScale?: number;
  modelYaw?: number;
  modelPitch?: number;
  modelRoll?: number;
  cameraDistance?: number;
  cameraFov?: number;
  lightIntensity?: number;
  script?: string;
  renderer?: '2d' | 'webgl2';
  params?: Record<string, number | string | boolean>;
}

export interface Scene {
  id: string;
  name: string;
  durationFrames: number;
  clip?: { inFrame: number; outFrame: number };
  layers: Layer[];
  program?: { entry: string; renderer: '2d' | 'webgl2'; seed: number; params?: Record<string, number | string | boolean>; edits?: ProgramEdits };
}

export interface AudioClip {
  id: string;
  asset: string;
  startFrame: number;
  sourceInFrame: number;
  durationFrames: number;
  volume: number;
  muted?: boolean;
  loop?: boolean;
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

export interface AudioTrack {
  id: string;
  name: string;
  clips: AudioClip[];
}

export interface ProjectManifest {
  formatVersion: 1 | 2 | 3;
  runtimeVersion?: '1.0.0';
  sdkVersion?: '1.0.0' | '1.1.0';
  capabilities?: ('canvas-scene' | 'webgl2-scene')[];
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  scenes: { id: string; file: string }[];
  audioTracks?: AudioTrack[];
}

export interface LoadedProject {
  manifest: ProjectManifest;
  scenes: Scene[];
  root: string;
  revision: string;
  sources?: Record<string, string>;
  resourcePrefix?: string;
  programs?: Record<string, { path?: string; hash: string; diagnostics: BuildDiagnostic[] }>;
}

export type BuildDiagnostic = { path?: string; line?: number; column?: number; message: string };

export type ExportKind = 'png' | 'mp4' | 'webm' | 'gif' | 'sequence';
export type ExportOptions = {
  width: number;
  height: number;
  fps: number;
  transparentBackground?: boolean;
  quality?: 'draft' | 'standard' | 'high';
  scope?: 'all' | 'scene' | 'range';
  startFrame?: number;
  endFrame?: number;
};
export type ProjectCheck = { ok: boolean; errors: string[]; warnings: string[]; missingAssets: string[] };
export type HistoryEntry = { id: string; createdAt: string };

export type RenderCommand = {
  requestId: string;
  project: LoadedProject;
  sceneIndex: number;
  frame: number;
  host: 'active' | 'export';
  capture?: boolean;
  transparentBackground?: boolean;
  captureSize?: { width: number; height: number };
  disabledLayerIds?: string[];
};

export type RenderResult = {
  requestId: string;
  ok: boolean;
  png?: string;
  errors?: string[];
  diagnostics?: { sceneId: string; layerId: string; path?: string; frame: number; message: string; stack?: string }[];
  programStats?: { sceneId: string; instanceId: string; initialized: boolean; evaluateMs: number; renderMs: number; nodes: number };
  programEdit?: ProgramFeedback;
  error?: string;
};

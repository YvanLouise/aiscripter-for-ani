import type { LoadedProject, ProjectCheck } from './types';

export type AiSession = {
  mode: 'editor' | 'offline';
  diskRevision: string;
  draftRevision: string;
  dirty: boolean;
  playhead?: number;
  undoId?: string;
  project: LoadedProject;
};

export type AiChange = {
  kind: 'update_layer' | 'add_layer' | 'remove_layer' | 'add_scene' | 'remove_scene' | 'reorder_scenes' | 'update_scene' | 'update_project' | 'write_script' | 'enable_programs';
  sceneId?: string;
  layerId?: string;
  patch?: Record<string, unknown>;
  value?: unknown;
  order?: string[];
  path?: string;
  source?: string;
};

export type AiStage = {
  id: string;
  expectedDraftRevision: string;
  expectedDiskRevision: string;
  summary: string[];
  check: ProjectCheck;
};

export type EditorAiRequest = {
  id: string;
  kind: 'inspect' | 'apply' | 'save' | 'rebase';
  project?: LoadedProject;
  expectedDraftRevision?: string;
};

export type AiJob = {
  id: string;
  state: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  progress: number;
  draftRevision: string;
  output?: string;
  error?: string;
};

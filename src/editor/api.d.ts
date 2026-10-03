import type { ExportKind, ExportOptions, HistoryEntry, LoadedProject, ProjectCheck } from '../shared/types';
import type { AiSession, EditorAiRequest } from '../shared/ai-service';

declare global {
  interface Window {
    ani: {
      sample: () => Promise<LoadedProject>;
      freshSample: () => Promise<LoadedProject>;
      create: () => Promise<LoadedProject | undefined>;
      recent: () => Promise<string[]>;
      openRecent: (root: string) => Promise<LoadedProject>;
      check: (project: LoadedProject) => Promise<ProjectCheck>;
      diff: (project: LoadedProject) => Promise<string[]>;
      history: () => Promise<HistoryEntry[]>;
      snapshot: (project: LoadedProject) => Promise<HistoryEntry>;
      restore: (id: string) => Promise<LoadedProject>;
      replaceResource: (project: LoadedProject, relative: string) => Promise<string | undefined>;
      listResources: () => Promise<string[]>;
      importResources: (project: LoadedProject) => Promise<{ assets: string[]; revision: string } | undefined>;
      guide: (section?: 'index' | 'format' | 'legacy' | 'ai' | 'mcp' | 'program') => Promise<string>;
      copyAiSpec: () => Promise<number>;
      open: () => Promise<LoadedProject | undefined>;
      reload: () => Promise<LoadedProject | undefined>;
      save: (project: LoadedProject) => Promise<LoadedProject>;
      prepareSources: (project: LoadedProject) => Promise<LoadedProject>;
      aiReply: (reply: { id: string; value?: AiSession; error?: string }) => void;
      onAiRequest: (callback: (request: EditorAiRequest) => void) => () => void;
      readScript: (relative: string) => Promise<string>;
      writeScript: (relative: string, source: string) => Promise<string>;
      importAudio: (project: LoadedProject) => Promise<{ asset: string; revision: string; durationFrames: number } | undefined>;
      waveform: (project: LoadedProject, asset: string, width: number, sourceInFrame: number, durationFrames: number) => Promise<string>;
      thumbnail: (project: LoadedProject, sceneIndex: number, frame: number) => Promise<string>;
      saveCopy: (project: LoadedProject) => Promise<LoadedProject | undefined>;
      export: (project: LoadedProject, kind: ExportKind, sceneIndex: number, frame: number, options: ExportOptions) => Promise<string | undefined>;
      ffmpeg: () => Promise<boolean>;
      resetRuntime: (contentsId: number) => Promise<void>;
      onExternalChange: (callback: () => void) => () => void;
    };
  }
}

export {};

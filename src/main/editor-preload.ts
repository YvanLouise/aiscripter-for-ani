import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ani', {
  sample: () => ipcRenderer.invoke('project:sample'),
  freshSample: () => ipcRenderer.invoke('project:sample-fresh'),
  create: () => ipcRenderer.invoke('project:new'),
  recent: () => ipcRenderer.invoke('project:recent'),
  openRecent: (root: string) => ipcRenderer.invoke('project:open-recent', root),
  check: (project: unknown) => ipcRenderer.invoke('project:check', project),
  diff: (project: unknown) => ipcRenderer.invoke('project:diff', project),
  history: () => ipcRenderer.invoke('project:history'),
  snapshot: (project: unknown) => ipcRenderer.invoke('project:snapshot', project),
  restore: (id: string) => ipcRenderer.invoke('project:restore', id),
  replaceResource: (project: unknown, relative: string) => ipcRenderer.invoke('resource:replace', project, relative),
  listResources: () => ipcRenderer.invoke('resource:list'),
  importResources: (project: unknown) => ipcRenderer.invoke('resource:import', project),
  guide: (section: 'index' | 'format' | 'legacy' | 'ai' | 'mcp' | 'program' = 'index') => ipcRenderer.invoke('guide:open', section),
  copyAiSpec: () => ipcRenderer.invoke('guide:copy-ai-spec'),
  open: () => ipcRenderer.invoke('project:open'),
  reload: () => ipcRenderer.invoke('project:reload'),
  save: (project: unknown) => ipcRenderer.invoke('project:save', project),
  prepareSources: (project: unknown) => ipcRenderer.invoke('project:prepare-sources', project),
  aiReply: (reply: unknown) => ipcRenderer.send('ai:reply', reply),
  onAiRequest: (callback: (request: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: unknown) => callback(request);
    ipcRenderer.on('ai:request', listener);
    return () => ipcRenderer.removeListener('ai:request', listener);
  },
  readScript: (relative: string) => ipcRenderer.invoke('script:read', relative),
  writeScript: (relative: string, source: string) => ipcRenderer.invoke('script:write', relative, source),
  importAudio: (project: unknown) => ipcRenderer.invoke('audio:import', project),
  waveform: (project: unknown, asset: string, width: number, sourceInFrame: number, durationFrames: number) => ipcRenderer.invoke('audio:waveform', project, asset, width, sourceInFrame, durationFrames),
  thumbnail: (project: unknown, sceneIndex: number, frame: number) => ipcRenderer.invoke('scene:thumbnail', project, sceneIndex, frame),
  saveCopy: (project: unknown) => ipcRenderer.invoke('project:save-copy', project),
  export: (project: unknown, kind: 'png' | 'mp4' | 'webm' | 'gif' | 'sequence', sceneIndex: number, frame: number, options: unknown) => ipcRenderer.invoke('project:export', project, kind, sceneIndex, frame, options),
  ffmpeg: () => ipcRenderer.invoke('system:ffmpeg'),
  resetRuntime: (contentsId: number) => ipcRenderer.invoke('runtime:reset', contentsId),
  onExternalChange: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('project:external-change', listener);
    return () => ipcRenderer.removeListener('project:external-change', listener);
  },
});

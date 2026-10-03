import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('runtimeHost', {
  onCommand: (callback: (command: unknown) => void) => {
    ipcRenderer.on('runtime:command', (_event, command) => callback(command));
  },
  result: (result: unknown) => {
    ipcRenderer.send('runtime:result', result);
    try { ipcRenderer.sendToHost('runtime:result', result); } catch { /* Standalone export window. */ }
  },
  progress: (progress: unknown) => {
    try { ipcRenderer.sendToHost('runtime:progress', progress); } catch { /* Standalone export window. */ }
  },
});

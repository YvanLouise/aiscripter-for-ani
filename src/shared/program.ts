import type { LoadedProject, ProjectManifest } from './types';

export const SDK_VERSION = '1.1.0';

export function enablePrograms(project: LoadedProject): void {
  project.manifest.formatVersion = 3;
  project.manifest.runtimeVersion = '1.0.0';
  project.manifest.sdkVersion = SDK_VERSION;
  project.manifest.capabilities = ['canvas-scene', 'webgl2-scene'];
}

export function savedManifest(project: LoadedProject): ProjectManifest {
  return { ...project.manifest, formatVersion: project.manifest.formatVersion === 3 ? 3 : 2,
    scenes: project.scenes.map(scene => ({ id: scene.id, file: `scenes/${scene.id}.json` })) };
}

import path from 'node:path';

export function bundledContentRoot(appRoot: string): string {
  return appRoot.endsWith('.asar') ? path.join(path.dirname(appRoot), 'content') : appRoot;
}

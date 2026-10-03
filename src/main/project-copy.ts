import path from 'node:path';

export function projectCopyFilter(root: string): (file: string) => boolean {
  return file => path.relative(root, file).split(path.sep)[0] !== '.aiscripter';
}

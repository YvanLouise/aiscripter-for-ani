import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HistoryEntry } from '../shared/types';
import { projectCopyFilter } from './project-copy';

function historyRoot(storage: string, projectRoot: string): string {
  const key = createHash('sha256').update(path.resolve(projectRoot).toLowerCase()).digest('hex');
  return path.join(storage, 'project-history', key);
}

export async function listHistory(storage: string, projectRoot: string): Promise<HistoryEntry[]> {
  const root = historyRoot(storage, projectRoot);
  let names: string[];
  try { names = await fs.readdir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return names.filter(name => /^\d{13}-[a-f0-9]{8}$/.test(name)).sort().reverse().map(id => ({
    id, createdAt: new Date(Number(id.slice(0, 13))).toISOString(),
  }));
}

export async function saveHistory(storage: string, projectRoot: string): Promise<HistoryEntry> {
  const root = historyRoot(storage, projectRoot);
  await fs.mkdir(root, { recursive: true });
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const temporary = path.join(root, `${id}.tmp`);
  const final = path.join(root, id);
  const excluded = new Set(['.git', '.aiscripter', '.aiscripter-backups', '.aiscripter-history', 'node_modules', 'dist', 'dist-electron']);
  try {
    await fs.cp(projectRoot, path.join(temporary, 'project'), {
      recursive: true,
      filter: async source => {
        const relative = path.relative(projectRoot, source);
        if (!relative) return true;
        if (excluded.has(relative.split(path.sep)[0])) return false;
        return !(await fs.lstat(source)).isSymbolicLink();
      },
    });
    await fs.rename(temporary, final);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
  for (const old of (await listHistory(storage, projectRoot)).slice(12)) {
    await fs.rm(path.join(root, old.id), { recursive: true, force: true });
  }
  return { id, createdAt: new Date(Number(id.slice(0, 13))).toISOString() };
}

export async function restoreHistory(storage: string, projectRoot: string, id: string): Promise<void> {
  if (!/^\d{13}-[a-f0-9]{8}$/.test(id)) throw new Error('Invalid history ID');
  const source = path.join(historyRoot(storage, projectRoot), id, 'project');
  await fs.access(path.join(source, 'project.json'));
  await fs.cp(source, projectRoot, { recursive: true, force: true, filter: projectCopyFilter(source) });
}

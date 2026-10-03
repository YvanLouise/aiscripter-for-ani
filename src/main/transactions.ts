import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type Entry = { relative: string; existed: boolean; remove: boolean };
type Journal = { version: 1; entries: Entry[] };
export type FileContent = string | Uint8Array | null | { copyFrom: string };

function inside(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) throw new Error('Invalid transaction path');
  const target = path.resolve(root, relative);
  if (path.relative(root, target).startsWith('..')) throw new Error('Transaction path escapes project');
  return target;
}

async function secureParent(root: string, relative: string): Promise<string> {
  const target = inside(root, relative);
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlink directory: ${relative}`);
  }
  try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error(`Symlink file: ${relative}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return target;
}

async function recover(root: string, directory: string): Promise<void> {
  const names = await fs.readdir(directory);
  for (const name of names.filter(value => /^[a-f0-9-]{36}$/.test(value))) {
    const folder = path.join(directory, name);
    if ((await fs.lstat(folder)).isSymbolicLink()) throw new Error('Symlink transaction journal');
    let journal: Journal;
    try { journal = JSON.parse(await fs.readFile(path.join(folder, 'journal.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { await fs.rm(folder, { recursive: true }); continue; } throw error; }
    if (journal.version !== 1 || !Array.isArray(journal.entries)) throw new Error('Invalid recovery journal');
    const committed = await fs.access(path.join(folder, 'committed')).then(() => true, () => false);
    if (!committed) for (const [index, entry] of journal.entries.entries()) {
      const target = await secureParent(root, entry.relative);
      if (entry.existed) {
        const temporary = path.join(folder, `restore-${index}`);
        await fs.copyFile(path.join(folder, `old-${index}`), temporary);
        await fs.rename(temporary, target);
      } else await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await fs.rm(folder, { recursive: true });
  }
}

async function locked<T>(root: string, action: (directory: string) => Promise<T>): Promise<T> {
  const metadata = await secureParent(root, '.aiscripter/write.lock');
  const directory = await secureParent(root, '.aiscripter/transactions/journal');
  const transactionRoot = path.dirname(directory);
  const identity = `${process.pid}:${randomUUID()}`;
  const owner = path.join(path.dirname(metadata), `owner-${identity.replace(':', '-')}.tmp`);
  const handle = await fs.open(owner, 'wx');
  try {
    await handle.writeFile(identity); await handle.sync();
  } finally { await handle.close(); }
  let acquired = false;
  try {
    // Publish a complete owner record so a crash cannot leave an empty lock.
    try { await fs.link(owner, metadata); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number((await fs.readFile(metadata, 'utf8')).split(':')[0]);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('PROJECT_BUSY: invalid writer lock');
      try { process.kill(pid, 0); throw new Error('PROJECT_BUSY: another save is in progress'); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure; }
      await fs.unlink(metadata);
      await fs.link(owner, metadata);
    }
    acquired = true;
    await recover(root, transactionRoot);
    for (const name of await fs.readdir(path.dirname(metadata))) {
      const match = name.match(/^owner-(\d+)-[a-f0-9-]{36}\.tmp$/);
      if (!match || name === path.basename(owner)) continue;
      try { process.kill(Number(match[1]), 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') await fs.unlink(path.join(path.dirname(metadata), name)); }
    }
    return await action(transactionRoot);
  } finally {
    if (acquired && await fs.readFile(metadata, 'utf8').catch(() => '') === identity) await fs.unlink(metadata);
    await fs.unlink(owner);
  }
}

export async function recoverProject(root: string): Promise<void> {
  const directory = path.join(root, '.aiscripter');
  if (!await fs.access(directory).then(() => true, () => false)) return;
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Symlink recovery metadata');
  const hasLock = await fs.access(path.join(directory, 'write.lock')).then(() => true, () => false);
  const journals = await fs.readdir(path.join(directory, 'transactions')).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
  if (!hasLock && !journals.some(name => /^[a-f0-9-]{36}$/.test(name))) return;
  await locked(root, async () => undefined);
}

export async function persistFiles(root: string, files: Record<string, FileContent>, beforeWrite?: () => Promise<void>, afterWrite?: (index: number) => void): Promise<void> {
  await locked(root, async directory => {
    await beforeWrite?.();
    const folder = path.join(directory, randomUUID());
    await fs.mkdir(folder);
    const entries: Entry[] = [];
    let prepared = false;
    try {
      for (const [relative, contents] of Object.entries(files)) {
        const target = await secureParent(root, relative);
        const index = entries.length;
        const existed = await fs.access(target).then(() => true, () => false);
        if (existed) await fs.copyFile(target, path.join(folder, `old-${index}`));
        if (contents !== null) {
          const staged = path.join(folder, `new-${index}`);
          if (typeof contents === 'object' && !(contents instanceof Uint8Array)) {
            const source = await fs.realpath(contents.copyFrom);
            const base = await fs.realpath(root);
            const relativeSource = path.relative(base, source);
            if (relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) throw new Error('Backup source escapes project');
            await fs.copyFile(source, staged);
            const handle = await fs.open(staged, 'r+');
            try { await handle.sync(); } finally { await handle.close(); }
          } else {
            const handle = await fs.open(staged, 'wx');
            try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
          }
        }
        entries.push({ relative, existed, remove: contents === null });
      }
      const handle = await fs.open(path.join(folder, 'journal.pending'), 'wx');
      try { await handle.writeFile(JSON.stringify({ version: 1, entries })); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(path.join(folder, 'journal.pending'), path.join(folder, 'journal.json'));
      prepared = true;
      for (const [index, entry] of entries.entries()) {
        const target = await secureParent(root, entry.relative);
        if (entry.remove) await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
        else await fs.rename(path.join(folder, `new-${index}`), target);
        afterWrite?.(index);
      }
      const marker = await fs.open(path.join(folder, 'committed'), 'wx');
      try { await marker.sync(); } finally { await marker.close(); }
    } catch (error) {
      if (prepared) await recover(root, directory);
      else await fs.rm(folder, { recursive: true, force: true });
      throw error;
    }
    await fs.rm(folder, { recursive: true });
  });
}

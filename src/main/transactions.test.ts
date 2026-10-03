import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { persistFiles, recoverProject } from './transactions';

describe('multi-file persistence and recovery', () => {
  it('discards an interrupted preparation journal without touching original files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ani-prepare-'));
    try {
      const folder = path.join(root, '.aiscripter', 'transactions', randomUUID());
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(root, 'project.json'), 'original');
      await fs.writeFile(path.join(folder, 'journal.pending'), '{"version":');
      await fs.writeFile(path.join(folder, 'new-0'), 'new');
      await recoverProject(root);
      expect(await fs.readFile(path.join(root, 'project.json'), 'utf8')).toBe('original');
      expect(await fs.readdir(path.dirname(folder))).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each([0, 1, 2])('rolls back all bytes when write %i fails', async failure => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ani-journal-'));
    try {
      await fs.writeFile(path.join(root, 'project.json'), 'original manifest');
      await fs.writeFile(path.join(root, 'old.json'), 'original scene');
      await expect(persistFiles(root, { 'project.json': 'new manifest', 'old.json': null, 'scripts/new.mjs': 'new script' }, undefined, index => { if (index === failure) throw new Error('Injected failure'); })).rejects.toThrow('Injected failure');
      expect(await fs.readFile(path.join(root, 'project.json'), 'utf8')).toBe('original manifest');
      expect(await fs.readFile(path.join(root, 'old.json'), 'utf8')).toBe('original scene');
      expect(await fs.access(path.join(root, 'scripts', 'new.mjs')).then(() => true, () => false)).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each([false, true])('recovers a stale writer journal with committed=%s', async committed => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ani-recovery-'));
    try {
      const folder = path.join(root, '.aiscripter', 'transactions', randomUUID());
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(root, '.aiscripter', 'write.lock'), '2147483647');
      await fs.writeFile(path.join(folder, 'old-0'), 'old');
      await fs.writeFile(path.join(folder, 'journal.json'), JSON.stringify({ version: 1, entries: [{ relative: 'project.json', existed: true, remove: false }] }));
      await fs.writeFile(path.join(root, 'project.json'), 'new');
      if (committed) await fs.writeFile(path.join(folder, 'committed'), '');
      await recoverProject(root);
      expect(await fs.readFile(path.join(root, 'project.json'), 'utf8')).toBe(committed ? 'new' : 'old');
      expect(await fs.readdir(path.dirname(folder))).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('refuses an active writer and escaped journal paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ani-lock-'));
    try {
      await fs.mkdir(path.join(root, '.aiscripter'));
      await fs.writeFile(path.join(root, '.aiscripter', 'write.lock'), String(process.pid));
      await expect(recoverProject(root)).rejects.toThrow('PROJECT_BUSY');
      await fs.unlink(path.join(root, '.aiscripter', 'write.lock'));
      await expect(persistFiles(root, { '../outside.txt': 'bad' })).rejects.toThrow('path');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

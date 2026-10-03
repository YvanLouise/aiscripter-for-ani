import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listHistory, restoreHistory, saveHistory } from './history';

let temporary = '';
afterEach(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

describe('project history', () => {
  it('restores project and script files while rejecting forged IDs', async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-history-test-'));
    const project = path.join(temporary, 'project');
    const storage = path.join(temporary, 'storage');
    await fs.mkdir(path.join(project, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(project, 'project.json'), '{"name":"first"}');
    await fs.writeFile(path.join(project, 'scripts', 'effect.mjs'), 'export const value = 1;');
    const entry = await saveHistory(storage, project);
    await fs.writeFile(path.join(project, 'project.json'), '{"name":"second"}');
    await fs.writeFile(path.join(project, 'scripts', 'effect.mjs'), 'export const value = 2;');
    expect((await listHistory(storage, project))[0].id).toBe(entry.id);
    await expect(restoreHistory(storage, project, '../project')).rejects.toThrow('Invalid history ID');
    await restoreHistory(storage, project, entry.id);
    expect(await fs.readFile(path.join(project, 'project.json'), 'utf8')).toContain('first');
    expect(await fs.readFile(path.join(project, 'scripts', 'effect.mjs'), 'utf8')).toContain('value = 1');
  });
});

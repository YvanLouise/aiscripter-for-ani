import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectCopyFilter } from './project-copy';

it('copies project content without leaking or restoring an active editor session', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ani-copy-'));
  try {
    const source = path.join(base, 'source'), target = path.join(base, 'target');
    await fs.mkdir(path.join(source, '.aiscripter'), { recursive: true });
    await fs.writeFile(path.join(source, '.aiscripter', 'mcp-session.json'), 'source session');
    await fs.writeFile(path.join(source, 'project.json'), 'project data');
    await fs.mkdir(path.join(target, '.aiscripter'), { recursive: true });
    await fs.writeFile(path.join(target, '.aiscripter', 'mcp-session.json'), 'target session');
    await fs.cp(source, target, { recursive: true, force: true, filter: projectCopyFilter(source) });
    expect(await fs.readFile(path.join(target, '.aiscripter', 'mcp-session.json'), 'utf8')).toBe('target session');
    expect(await fs.readFile(path.join(target, 'project.json'), 'utf8')).toBe('project data');
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

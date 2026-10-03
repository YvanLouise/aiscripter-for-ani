import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { callBridge, readBridge, startBridge } from './ai-bridge';

it('routes only authenticated project-session requests and removes its descriptor on close', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ani-bridge-'));
  let close: (() => Promise<void>) | undefined;
  try {
    close = await startBridge(root, async request => ({ method: request.method }));
    expect(await callBridge(root, { method: 'session' })).toEqual({ method: 'session' });
    const descriptor = (await readBridge(root))!;
    const rejected = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(descriptor.endpoint);
      let buffer = '';
      socket.on('error', reject);
      socket.on('connect', () => socket.write(JSON.stringify({ token: 'wrong', method: 'session' }) + '\n'));
      socket.on('data', chunk => { buffer += chunk.toString(); });
      socket.on('end', () => resolve(buffer));
    });
    expect(rejected).toContain('Unauthorized');
    await close(); close = undefined;
    expect(await readBridge(root)).toBeUndefined();
  } finally { await close?.(); await fs.rm(root, { recursive: true, force: true }); }
});

import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type Descriptor = { version: 1; pid: number; endpoint: string; token: string };
const limit = 16 * 1024 * 1024;
const execute = promisify(execFile);
export type BridgeRequest = { method: string; args?: unknown };

export async function readBridge(root: string): Promise<Descriptor | undefined> {
  try {
    const descriptor = JSON.parse(await fs.readFile(path.join(root, '.aiscripter', 'mcp-session.json'), 'utf8')) as Descriptor;
    if (descriptor.version !== 1 || !descriptor.endpoint.startsWith(process.platform === 'win32' ? '\\\\.\\pipe\\aiscripter-' : '/tmp/aiscripter-') || !/^[a-f0-9-]{36}$/.test(descriptor.token)) throw new Error('Invalid editor session descriptor');
    return descriptor;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function startBridge(root: string, handle: (request: BridgeRequest) => Promise<unknown>): Promise<() => Promise<void>> {
  const old = await readBridge(root);
  if (old) {
    try { process.kill(old.pid, 0); throw new Error('Another editor already owns this project session'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  const descriptor: Descriptor = { version: 1, pid: process.pid, endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\aiscripter-${randomUUID()}` : `/tmp/aiscripter-${randomUUID()}.sock`, token: randomUUID() };
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined);
    socket.setTimeout(120000, () => socket.destroy());
    let buffer = ''; let accepted = false;
    socket.on('data', chunk => {
      if (accepted) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > limit) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      accepted = true;
      void (async () => {
        try {
          const input = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          const token = Buffer.from(String(input.token || ''));
          const expected = Buffer.from(descriptor.token);
          if (token.length !== expected.length || !timingSafeEqual(token, expected)) throw new Error('Unauthorized session');
          const value = await handle({ method: input.method, args: input.args });
          socket.end(`${JSON.stringify({ value })}\n`);
        } catch (error) { socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`); }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(descriptor.endpoint, () => { server.off('error', reject); resolve(); }); });
  const metadata = path.join(root, '.aiscripter');
  await fs.mkdir(metadata, { recursive: true });
  if ((await fs.lstat(metadata)).isSymbolicLink()) { server.close(); throw new Error('Symlink session metadata'); }
  const file = path.join(metadata, 'mcp-session.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, '', { mode: 0o600, flag: 'wx' });
    if (process.platform === 'win32') {
      const identity = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000 });
      const sid = identity.stdout.match(/S-1-(?:\d+-)*\d+/)?.[0];
      if (!sid) throw new Error('Cannot resolve current Windows user for session ACL');
      await execute('icacls.exe', [temporary, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true, timeout: 5000 });
    }
    await fs.writeFile(temporary, JSON.stringify(descriptor));
    await fs.rename(temporary, file);
  } catch (error) { server.close(); await fs.rm(temporary, { force: true }); throw error; }
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if ((await readBridge(root))?.token === descriptor.token) await fs.unlink(file);
  };
}

export async function callBridge(root: string, request: BridgeRequest): Promise<unknown> {
  const descriptor = await readBridge(root);
  if (!descriptor) throw new Error('EDITOR_UNAVAILABLE: open this project in AIScripter');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(descriptor.endpoint);
    let buffer = '';
    const timer = setTimeout(() => socket.destroy(new Error('Editor request timed out')), 120000);
    const finish = (error?: Error, value?: unknown) => { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(value); };
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...request, token: descriptor.token })}\n`));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > limit) { finish(new Error('Editor response exceeds 16 MB')); return; }
      if (!buffer.includes('\n')) return;
      try { const reply = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); finish(reply.error ? new Error(reply.error) : undefined, reply.value); }
      catch (error) { finish(error as Error); }
    });
    socket.on('error', error => finish(new Error(`EDITOR_UNAVAILABLE: ${error.message}`)));
    socket.on('end', () => { if (!buffer.includes('\n')) finish(new Error('Incomplete editor response')); });
  });
}

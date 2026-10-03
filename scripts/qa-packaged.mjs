import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.resolve(process.argv[2] || path.join(root, 'release/win-unpacked/AIScripter for ani.exe'));
const resources = path.join(path.dirname(executable), 'resources');
const encoder = path.join(resources, 'ffmpeg/ffmpeg.exe');
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-packaged-qa-'));
const output = path.join(root, '.qa/packaged');
const timers = new Set();
const assert = (value, message) => { if (!value) throw new Error(message); };

async function command(file, args, timeout = 60000) {
  const child = spawn(file, args, { cwd: base, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill(), timeout); timers.add(timer);
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer); timers.delete(timer);
  if (code) throw new Error(`${path.basename(file)} failed (${code}): ${Buffer.concat(stderr).toString().slice(-4000)}`);
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() };
}

async function editor(args, report, timeout = 180000) {
  for (const suffix of ['.json', '.error.txt']) await fs.unlink(report + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await command(executable, args, timeout);
  const failure = await fs.readFile(report + '.error.txt', 'utf8').catch(() => undefined);
  if (failure) throw new Error(failure);
  return JSON.parse(await fs.readFile(report + '.json', 'utf8'));
}

async function mcp(project) {
  const child = spawn(path.join(path.dirname(executable), 'AIScripter MCP.exe'), ['--project', project, '--offline'], { cwd: base, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  const pending = new Map(); let nextId = 1, buffer = '', stderr = '', parseError;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const fail = message => { for (const callback of pending.values()) callback({ error: { message } }); pending.clear(); };
  child.once('error', error => fail(error.message));
  child.once('close', code => fail(`MCP exited ${code}: ${stderr}`));
  const timer = setTimeout(() => { fail(`MCP timeout: ${stderr}`); child.kill(); }, 30000); timers.add(timer);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      try { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); }
      catch { parseError = 'MCP stdout contains non-JSON output'; fail(parseError); }
    }
  });
  const call = (method, params = {}) => new Promise(resolve => {
    if (parseError) return resolve({ error: { message: parseError } });
    const id = nextId++; pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const response = await call('tools/call', { name, arguments: args });
    assert(!response.error && !response.result?.isError, `${name}: ${JSON.stringify(response)}`);
    return response.result.content.find(item => item.type === 'text').text;
  };
  try {
    const initialized = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'packaged-qa', version: '1.0' } });
    assert(!initialized.error, JSON.stringify(initialized.error));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await call('tools/list');
    assert(listed.result?.tools?.length === 18, 'Packaged MCP tool registry is incomplete');
    assert((await tool('read_documentation', { section: 'format_v3' })).includes('formatVersion'), 'Packaged format documentation missing');
    assert((await tool('read_documentation', { section: 'sdk' })).includes('defineScene'), 'Packaged SDK missing');
    const inspected = JSON.parse(await tool('inspect_project'));
    assert(inspected.scenes.length === 3 && inspected.manifest.id === 'aiscripter-default-motion', 'Packaged MCP project inspection failed');
    assert(JSON.parse(await tool('validate_project', { strict_resources: true })).valid, 'Bundled project resources missing');
    const built = JSON.parse(await tool('build_project', { draft_revision: inspected.draftRevision }));
    assert(built.ok && Object.keys(built.programs).length === 3, `Packaged TypeScript/esbuild failed: ${JSON.stringify(built)}`);
    const forbidden = await call('tools/call', { name: 'read_project_file', arguments: { relative_path: '../package.json' } });
    assert(forbidden.result?.isError, 'Packaged MCP allowed path traversal');
    return { tools: 18, bundledDocumentation: true, typedPrograms: true, traversalRejected: true };
  } finally {
    clearTimeout(timer); timers.delete(timer); child.stdin.end();
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) { child.kill(); await closed; }
  }
}

try {
  await fs.access(executable); await fs.mkdir(output, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(resources, 'ffmpeg/manifest.json'), 'utf8'));
  assert(createHash('sha256').update(await fs.readFile(encoder)).digest('hex') === manifest.sha256, 'Installed encoder checksum mismatch');
  const version = (await command(encoder, ['-version'])).stdout.toString();
  const content = path.join(resources, 'content');
  for (const file of ['LICENSE', 'AIS-icon.ico', 'docs/README.md', 'schema/project-v3.schema.json', 'src/sdk/index.ts']) await fs.access(path.join(content, file));
  const project = path.join(base, 'project');
  const source = path.join(content, 'examples/default-animation');
  await fs.cp(source, project, { recursive: true });
  const mcpReport = await mcp(project);
  console.log('Installed MCP: 18 tools, bundled documentation, all typed scenes compiled, path traversal rejected.');
  const screenshot = path.join(output, 'editor.png');
  const report = await editor([`--user-data-dir=${path.join(base, 'profile')}`, `--ani-qa-screenshot=${screenshot}`, '--ani-qa-default-demo'], screenshot);
  const checks = ['startup', 'storyboard', 'allChaptersRendered', 'seamMapping', 'deterministic', 'previewIsolation', 'nativeTitleEditing', 'independentInstances', 'saveReopen', 'mediaStrip', 'freshCopy', 'editsPreserved'];
  assert(checks.every(key => report.defaultDemoProbe?.[key]) && report.state.url === 'app://editor/index.html' && report.state.hasAni && report.guestState.stageWidth === 1920 && report.guestState.pngLength > 10000, 'Packaged native editor verification incomplete');
  console.log(`Packaged native editor: ${checks.length} checks passed. Exporting 540 frames...`);
  if (!process.argv.includes('--smoke')) {
  assert(version.includes(`ffmpeg version ${manifest.version}`), 'Unexpected bundled FFmpeg version');
  const video = path.join(output, 'default-animation.mp4');
  await editor([`--user-data-dir=${path.join(base, 'export-profile')}`, `--ani-qa-project=${project}`, `--ani-qa-export=${video}`, '--ani-qa-output=1920x1080@30'], video, 300000);
  const probe = (await command(encoder, ['-hide_banner', '-i', video, '-map', '0:v:0', '-f', 'null', '-'])).stderr;
  const frames = Number([...probe.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1]);
  const duration = probe.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : NaN;
  assert(frames === 540 && /Video: h264/.test(probe) && /1920x1080/.test(probe) && /30 fps/.test(probe) && /Audio: aac/.test(probe) && Math.abs(seconds - 18) < 0.04, `Invalid packaged MP4: ${probe.slice(-4000)}`);
  const pcm = (await command(encoder, ['-v', 'error', '-i', video, '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '44100', '-'])).stdout;
  let square = 0;
  for (let index = 0; index + 1 < pcm.length; index += 2) square += (pcm.readInt16LE(index) / 32768) ** 2;
  const audioRms = Math.sqrt(square / (pcm.length / 2));
  assert(audioRms > 0.001 && pcm.length > 44100 * 17.9 * 2, 'Packaged score is missing or silent');
  for (const format of ['webm', 'gif']) {
    const file = path.join(output, `short.${format}`);
    await editor([`--user-data-dir=${path.join(base, `${format}-profile`)}`, `--ani-qa-project=${project}`, `--ani-qa-export=${file}`, '--ani-qa-output=480x270@30', '--ani-qa-range=0:8'], file);
    const decoded = (await command(encoder, ['-hide_banner', '-i', file, '-map', '0:v:0', '-f', 'null', '-'])).stderr;
    assert(Number([...decoded.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1]) === 8, `Invalid ${format} frame count`);
    if (format === 'webm') assert(/Video: vp9/.test(decoded) && /Audio: opus/.test(decoded), 'WebM codecs missing');
  }
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ executable, ffmpeg: manifest.version, mcp: mcpReport, nativeChecks: checks, export: { frames, width: 1920, height: 1080, fps: 30, seconds, audioRms, h264: true, aac: true, webm: true, gif: true } }, null, 2));
  console.log('Packaged export: 540 frames, 1080p30, H.264/AAC and audible score; WebM/Opus and GIF passed.');
  } else console.log('Installed application smoke checks passed.');
} finally {
  for (const timer of timers) clearTimeout(timer);
  const actual = await fs.realpath(base), relative = path.relative(await fs.realpath(os.tmpdir()), actual);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(actual).startsWith('aiscripter-packaged-qa-')) await fs.rm(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

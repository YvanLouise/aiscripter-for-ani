import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-object-qa-'));
const project = path.join(base, 'project'), output = path.join(root, '.qa/object-edit/editor.png');
let timer;
try {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const source = path.join(root, 'examples/program-scenes');
  await fs.cp(source, project, { recursive: true, filter: file => path.relative(source, file).split(path.sep)[0] !== '.aiscripter' });
  for (const suffix of ['.json', '.error.txt']) await fs.unlink(output + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const child = spawn(electron, [root, `--user-data-dir=${path.join(base, 'profile')}`, `--ani-qa-project=${project}`, `--ani-qa-screenshot=${output}`, '--ani-qa-object-edit'], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  timer = setTimeout(() => child.kill(), 180000);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const failure = await fs.readFile(output + '.error.txt', 'utf8').catch(() => undefined);
  if (failure) throw new Error(failure);
  const report = JSON.parse(await fs.readFile(output + '.json', 'utf8').catch(() => { throw new Error(`Electron QA produced no report: ${stderr}`); }));
  const checks = ['publicParameterKeys', 'canvasDrag', 'canvasScaleRotate', 'gestureUndoRedo', 'independentInstances', 'mcpLocks', 'aiPreservesEdits', 'deterministicEditedSeek', 'unboundRecovery', 'manualRebind', 'editedExport', 'saveReopen', 'nonBlankUi'];
  if (checks.some(key => !report.objectEditProbe?.[key])) throw new Error('Incomplete object editing QA report');
  const decoded = spawn(ffmpeg.path, ['-hide_banner', '-i', output + '.preview.mp4', '-map', '0:v:0', '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let probe = ''; decoded.stderr.on('data', chunk => { probe += chunk.toString(); });
  const code = await new Promise((resolve, reject) => { decoded.once('error', reject); decoded.once('close', resolve); });
  const frames = Number([...probe.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1]);
  if (code !== 0 || frames !== 30 || !/Video: h264/.test(probe) || !/960x540/.test(probe) || !/Audio: aac/.test(probe)) throw new Error(`Edited MP4 verification failed: ${probe.slice(-3000)}`);
  await fs.writeFile(output + '.verification.json', JSON.stringify({ frames, width: 960, height: 540, fps: 30, video: 'h264', audio: 'aac', decodedSuccessfully: true }, null, 2));
  console.log(`Electron + object editing: ${checks.length} checks passed; artifacts: ${output}`);
} finally {
  clearTimeout(timer);
  const realBase = await fs.realpath(base), relative = path.relative(await fs.realpath(os.tmpdir()), realBase);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(realBase).startsWith('aiscripter-object-qa-')) await fs.rm(realBase, { recursive: true, force: true });
}

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-default-qa-'));
const screenshot = path.join(root, '.qa/default-animation/editor.png'), video = path.join(root, 'artifacts/default-animation.mp4');
let timer;
async function run(args, report, timeout) {
  for (const suffix of ['.json', '.error.txt']) await fs.unlink(report + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const child = spawn(electron, [root, ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  timer = setTimeout(() => child.kill(), timeout);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  const failure = await fs.readFile(report + '.error.txt', 'utf8').catch(() => undefined);
  if (failure) throw new Error(failure);
  return JSON.parse(await fs.readFile(report + '.json', 'utf8').catch(() => { throw new Error(`Missing Electron report: ${stderr}`); }));
}
try {
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  await fs.mkdir(path.dirname(video), { recursive: true });
  const report = await run([`--user-data-dir=${path.join(base, 'profile')}`, `--ani-qa-screenshot=${screenshot}`, '--ani-qa-default-demo'], screenshot, 180000);
  const checks = ['startup', 'storyboard', 'allChaptersRendered', 'seamMapping', 'deterministic', 'previewIsolation', 'nativeTitleEditing', 'independentInstances', 'saveReopen', 'mediaStrip', 'freshCopy', 'editsPreserved'];
  if (checks.some(key => !report.defaultDemoProbe?.[key]) || report.state.url !== 'app://editor/index.html' || !report.state.hasAni || report.guestState.stageWidth !== 1920 || report.guestState.pngLength < 10000) throw new Error('Default animation UI verification incomplete');
  console.log(`Default animation: ${checks.length} native Electron checks passed. Exporting 540 frames...`);
  const project = path.join(base, 'export-project');
  const source = path.join(root, 'examples/default-animation');
  await fs.cp(source, project, { recursive: true, filter: file => path.relative(source, file).split(path.sep)[0] !== '.aiscripter' });
  await run([`--user-data-dir=${path.join(base, 'export-profile')}`, `--ani-qa-project=${project}`, `--ani-qa-export=${video}`, '--ani-qa-output=1920x1080@30'], video, 240000);
  const decoder = spawn(ffmpeg.path, ['-hide_banner', '-i', video, '-map', '0:v:0', '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let probe = '';
  decoder.stderr.on('data', chunk => { probe += chunk.toString(); });
  const code = await new Promise((resolve, reject) => { decoder.once('error', reject); decoder.once('close', resolve); });
  const frames = Number([...probe.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1]), duration = probe.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  const containerSeconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : NaN;
  if (code !== 0 || frames !== 540 || !/Video: h264/.test(probe) || !/1920x1080/.test(probe) || !/30 fps/.test(probe) || !/Audio: aac/.test(probe) || Math.abs(containerSeconds - 18) > 0.03) throw new Error(`Incorrect default MP4: ${probe.slice(-6000)}`);
  const audio = spawn(ffmpeg.path, ['-v', 'error', '-i', video, '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '44100', '-'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let audioError = '';
  audio.stdout.on('data', chunk => chunks.push(chunk)); audio.stderr.on('data', chunk => { audioError += chunk.toString(); });
  const audioCode = await new Promise((resolve, reject) => { audio.once('error', reject); audio.once('close', resolve); });
  const pcm = Buffer.concat(chunks); let square = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) square += (pcm.readInt16LE(i) / 32768) ** 2;
  const audioRms = Math.sqrt(square / (pcm.length / 2));
  if (audioCode || audioRms < 0.001 || pcm.length < 44100 * 17.9 * 2) throw new Error(`Missing audible score: ${audioError}`);
  await fs.writeFile(video + '.verification.json', JSON.stringify({ frames, width: 1920, height: 1080, fps: 30, durationSeconds: 18, containerSeconds, video: 'h264', audio: 'aac', audioRms, decodedSuccessfully: true }, null, 2));
  console.log(`Default demo: 540 frames, 1920x1080, 30 fps, 18 seconds, H.264/AAC, audible original score; ${video}`);
} finally {
  clearTimeout(timer);
  const realBase = await fs.realpath(base), relative = path.relative(await fs.realpath(os.tmpdir()), realBase);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(realBase).startsWith('aiscripter-default-qa-')) await fs.rm(realBase, { recursive: true, force: true });
}

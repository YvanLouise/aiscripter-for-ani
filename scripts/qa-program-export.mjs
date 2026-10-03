import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-program-export-'));
const project = path.join(base, 'project'), output = path.join(root, 'artifacts/qa-program-full.mp4');
let timer;
try {
  const source = path.join(root, 'examples/program-scenes');
  await fs.cp(source, project, { recursive: true, filter: file => path.relative(source, file).split(path.sep)[0] !== '.aiscripter' });
  for (const suffix of ['.json', '.error.txt']) await fs.unlink(output + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const child = spawn(electron, [root, `--user-data-dir=${path.join(base, 'profile')}`, `--ani-qa-project=${project}`, `--ani-qa-export=${output}`, '--ani-qa-output=1920x1080@30'], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  timer = setTimeout(() => child.kill(), 180000);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  const failure = await fs.readFile(output + '.error.txt', 'utf8').catch(() => undefined);
  if (failure) throw new Error(failure);
  await fs.readFile(output + '.json').catch(() => { throw new Error(`Export produced no report: ${stderr}`); });
  const decoded = spawn(ffmpeg.path, ['-hide_banner', '-i', output, '-map', '0:v:0', '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let probe = '';
  decoded.stderr.on('data', chunk => { probe += chunk.toString(); });
  const code = await new Promise((resolve, reject) => { decoded.once('error', reject); decoded.once('close', resolve); });
  const matches = [...probe.matchAll(/frame=\s*(\d+)/g)], frames = Number(matches.at(-1)?.[1]);
  const durationMatch = probe.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  const containerSeconds = durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : NaN;
  if (code !== 0 || frames !== 450 || !/Video: h264/.test(probe) || !/1920x1080/.test(probe) || !/30 fps/.test(probe) || !/Audio: aac/.test(probe) || Math.abs(containerSeconds - 15) > 0.03) throw new Error(`Incorrect MP4 output: ${probe.slice(-6000)}`);
  await fs.writeFile(output + '.verification.json', JSON.stringify({ frames, width: 1920, height: 1080, fps: 30, durationSeconds: 15, containerSeconds, video: 'h264', audio: 'aac', decodedSuccessfully: true }, null, 2));
  console.log(`Mixed v3 export: 450 frames, 1920x1080, 30 fps, 15 seconds, H.264/AAC; ${output}`);
} finally {
  clearTimeout(timer);
  const realBase = await fs.realpath(base), relative = path.relative(await fs.realpath(os.tmpdir()), realBase);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(realBase).startsWith('aiscripter-program-export-')) await fs.rm(realBase, { recursive: true, force: true });
}

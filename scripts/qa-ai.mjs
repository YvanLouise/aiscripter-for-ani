import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-ai-qa-'));
const project = path.join(base, 'project');
const output = path.join(root, 'artifacts', 'qa-ai-loop.png');
let timer;
try {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const source = path.join(root, 'examples', 'solar-system');
  await fs.cp(source, project, { recursive: true, filter: file => path.relative(source, file).split(path.sep)[0] !== '.aiscripter' });
  for (const suffix of ['.json', '.error.txt']) await fs.unlink(output + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const child = spawn(electron, [root, `--user-data-dir=${path.join(base, 'profile')}`, `--ani-qa-project=${project}`, `--ani-qa-screenshot=${output}`, '--ani-qa-ai'], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  timer = setTimeout(() => child.kill(), 180000);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const failure = await fs.readFile(output + '.error.txt', 'utf8').catch(() => undefined);
  if (failure) throw new Error(failure);
  const report = JSON.parse(await fs.readFile(output + '.json', 'utf8').catch(() => { throw new Error(`Electron QA produced no report: ${stderr}`); }));
  const checks = ['unsavedHumanEdit', 'oneUndoForSceneAndScripts', 'redo', 'staleStageRejected', 'runtimeErrorLocated', 'importedAssetRebased', 'cancelledPreview', 'saveAndReopen'];
  if (checks.some(key => !report.aiProbe?.[key])) throw new Error('Incomplete AI QA report');
  console.log(`Electron + MCP: ${checks.length} checks passed; screenshot, frame and MP4 artifacts: ${output}`);
} finally {
  clearTimeout(timer);
  const realBase = await fs.realpath(base);
  const relative = path.relative(await fs.realpath(os.tmpdir()), realBase);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(realBase).startsWith('aiscripter-ai-qa-')) await fs.rm(realBase, { recursive: true, force: true });
}

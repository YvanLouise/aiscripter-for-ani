import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const installer = path.join(root, 'release', `AIScripter-for-ani-${meta.version}-x64-Setup.exe`);
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-install-qa-'));
const install = path.join(base, 'app');
const executable = path.join(install, 'AIScripter for ani.exe');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function run(file, args, options = {}) {
  const child = spawn(file, args, { cwd: base, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const output = []; child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk));
  const timer = setTimeout(() => child.kill(), 240000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  if (code) throw new Error(`Installer QA failed (${code}): ${Buffer.concat(output).toString().slice(-5000)}`);
  return Buffer.concat(output).toString();
}

const registryProbe = "$paths = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); @(Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'AIScripter for ani' } | Select-Object DisplayName,InstallLocation) | ConvertTo-Json -Compress";
let installed = false;
try {
  await fs.access(installer);
  const existing = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', registryProbe]);
  if (existing.trim() && existing.trim() !== '[]') throw new Error('An existing installation is registered. Installer QA must run on a clean Windows profile to preserve it.');
  const relative = path.relative(await fs.realpath(os.tmpdir()), await fs.realpath(base));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(base).startsWith('aiscripter-install-qa-')) throw new Error('Invalid installer QA directory');
  // NSIS /D and _?= require unquoted final parameters, including paths with spaces.
  await run(installer, ['/S', '/currentuser', `/D=${install}`], { windowsVerbatimArguments: true });
  installed = true;
  await fs.access(executable);
  for (const file of ['AIScripter for ani.exe', 'resources/app.asar', 'resources/ffmpeg/ffmpeg.exe']) {
    const original = await fs.readFile(path.join(root, 'release/win-unpacked', file));
    const copy = await fs.readFile(path.join(install, file));
    if (sha(original) !== sha(copy)) throw new Error(`Installer changed ${file}`);
  }
  console.log('NSIS installation: executable, app archive and encoder match the verified package.');
  await run(process.execPath, [path.join(root, 'scripts/qa-packaged.mjs'), executable, '--smoke']);
  const registration = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', registryProbe]);
  const entries = registration.trim() ? JSON.parse(registration) : [];
  if (![].concat(entries).some(item => path.resolve(item.InstallLocation || '.') === install)) throw new Error('Uninstall registration did not point to the test installation');
} finally {
  if (installed) {
    const uninstaller = (await fs.readdir(install)).find(name => /^Uninstall .*\.exe$/i.test(name));
    if (!uninstaller) throw new Error(`Missing uninstaller: ${install}`);
    await run(path.join(install, uninstaller), ['/S', '/currentuser', `_?=${install}`], { windowsVerbatimArguments: true });
    if (await fs.access(executable).then(() => true, () => false)) throw new Error('Uninstaller left the application executable');
    const registration = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', registryProbe]);
    if (registration.trim() && registration.trim() !== '[]') throw new Error('Uninstaller left its registry entry');
    console.log('NSIS uninstall: application and registration removed.');
  }
  const actual = await fs.realpath(base), relative = path.relative(await fs.realpath(os.tmpdir()), actual);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(actual).startsWith('aiscripter-install-qa-')) await fs.rm(actual, { recursive: true, force: true });
}

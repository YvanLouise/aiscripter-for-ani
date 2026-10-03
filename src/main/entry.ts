import { app } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';

if (app.isPackaged) {
  process.env.ESBUILD_BINARY_PATH = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
}
const mcpIndex = process.argv.indexOf('--mcp');
if (mcpIndex >= 0) {
  const child = spawn(process.execPath, [path.join(app.getAppPath(), 'dist-tools', 'aiscripter-mcp.cjs'), ...process.argv.slice(mcpIndex + 1)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.on('error', error => { console.error(error.message); app.exit(1); });
  child.on('close', code => app.exit(code ?? 1));
  process.stdin.on('end', () => child.stdin.end());
  app.on('before-quit', () => child.kill());
} else {
  app.setAppUserModelId('io.github.yvanlouise.aiscripter-for-ani');
  if (!process.argv.some(argument => argument.startsWith('--user-data-dir'))) app.setPath('userData', path.join(app.getPath('appData'), 'aiscripter-for-ani'));
  require('./main');
}

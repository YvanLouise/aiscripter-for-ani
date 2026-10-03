import { app } from 'electron';
import path from 'node:path';

if (app.isPackaged) {
  process.env.ESBUILD_BINARY_PATH = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
}
app.setAppUserModelId('io.github.yvanlouise.aiscripter-for-ani');
if (!process.argv.some(argument => argument.startsWith('--user-data-dir'))) app.setPath('userData', path.join(app.getPath('appData'), 'aiscripter-for-ani'));
require('./main');

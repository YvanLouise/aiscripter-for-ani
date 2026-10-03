const { promises: fs } = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  const output = context.appOutDir;
  const licenses = path.join(output, 'resources/licenses');
  await fs.mkdir(licenses, { recursive: true });
  for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
    await fs.copyFile(path.join(output, file), path.join(licenses, file));
  }
  await fs.access(path.join(output, 'resources/compiler/typescript/lib/lib.dom.d.ts'));
  await fs.access(path.join(output, 'resources/compiler/typescript/lib/lib.es2022.d.ts'));
};

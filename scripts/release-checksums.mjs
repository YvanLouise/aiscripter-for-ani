import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'release');
await fs.copyFile(path.join(root, '.build/ffmpeg/third-party-sources.tar.gz'), path.join(output, 'third-party-sources.tar.gz'));
const names = [`AIScripter-for-ani-${meta.version}-x64-Setup.exe`, 'third-party-sources.tar.gz'];
const lines = [];
for (const name of names) lines.push(`${createHash('sha256').update(await fs.readFile(path.join(output, name))).digest('hex')}  ${name}`);
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));

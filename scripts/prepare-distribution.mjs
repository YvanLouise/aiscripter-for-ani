import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, '.build/notices');
await fs.access(path.join(root, '.build/mcp/AIScripter MCP.exe')).catch(() => { throw new Error('Download the mcp-win64 workflow artifact into .build/mcp before packaging.'); });
const binary = await fs.readFile(path.join(root, '.build/ffmpeg/runtime/ffmpeg.exe')).catch(() => { throw new Error('Build or download the ffmpeg-build workflow artifact into .build/ffmpeg before packaging. See docs/distribution.zh-CN.md.'); });
const ffmpeg = JSON.parse(await fs.readFile(path.join(root, '.build/ffmpeg/runtime/manifest.json'), 'utf8'));
if (createHash('sha256').update(binary).digest('hex') !== ffmpeg.sha256) throw new Error('Bundled FFmpeg checksum mismatch');
await fs.access(path.join(root, '.build/ffmpeg/third-party-sources.tar.gz'));
const expectedSources = JSON.parse(await fs.readFile(path.join(root, 'build-resources/ffmpeg-sources.json'), 'utf8'));
for (const [name, source] of Object.entries(expectedSources)) if (ffmpeg.sources[name]?.commit !== source.commit) throw new Error(`Incorrect FFmpeg source version: ${name}`);
await fs.mkdir(destination, { recursive: true });
await fs.copyFile(path.join(root, 'LICENSE'), path.join(destination, 'AIScripter-MIT.txt'));
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const notices = ['AIScripter for ani - Third-party notices', 'The application is MIT licensed. Third-party components retain their own licenses.', ffmpeg.license + ' FFmpeg: see resources/ffmpeg/README.txt and matching release source archive.'];
for (const [relative, item] of Object.entries(lock.packages)) {
  if (!relative || item.dev) continue;
  const directory = path.join(root, relative), meta = await fs.readFile(path.join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => undefined);
  if (!meta) continue;
  notices.push(`\n${meta.name} ${meta.version} | ${typeof meta.license === 'string' ? meta.license : JSON.stringify(meta.license || 'See upstream license')}\n${JSON.stringify(meta.repository || meta.homepage || '')}`);
  const licenses = (await fs.readdir(directory)).filter(file => /^(LICENSE|LICENCE|COPYING)(\.|$)/i.test(file));
  for (const file of licenses) if ((await fs.stat(path.join(directory, file))).isFile()) notices.push(await fs.readFile(path.join(directory, file), 'utf8'));
}
await fs.writeFile(path.join(destination, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'));
console.log('Distribution verified: FFmpeg source identity/checksum, source archive, MIT and dependency notices.');

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.build/ffmpeg/source-archives');
const sources = JSON.parse(await fs.readFile(path.join(root, 'build-resources/ffmpeg-sources.json'), 'utf8'));
await fs.mkdir(directory, { recursive: true });
const manifest = {};
for (const [name, source] of Object.entries(sources)) {
  if (!/^[a-f0-9]{40}$/.test(source.commit) || !/^[\w.-]+\/[\w.-]+$/.test(source.repository)) throw new Error('Invalid source identity');
  const url = `https://codeload.github.com/${source.repository}/tar.gz/${source.commit}`, file = path.join(directory, `${name}.tar.gz`);
  let bytes = await fs.readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!bytes) {
    let failure;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`Source download ${name}: HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer()); break;
      } catch (error) { failure = error; }
    }
    if (!bytes) throw failure;
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error(`Invalid source archive: ${name}`);
    await fs.writeFile(file, bytes);
  }
  manifest[name] = { ...source, url, archive: `${name}.tar.gz`, sha256: createHash('sha256').update(bytes).digest('hex') };
  console.log(`Source ${name} ${source.version}: ${manifest[name].sha256}`);
}
await fs.writeFile(path.join(directory, 'sources.json'), JSON.stringify(manifest, null, 2));

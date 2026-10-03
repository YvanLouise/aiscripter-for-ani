import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), base = path.join(root, '.build/ffmpeg');
const sources = JSON.parse(await fs.readFile(path.join(base, 'source-archives/sources.json'), 'utf8'));
const notice = `FFmpeg 9.0.2 - GPL version 3 or later\nCopyright the FFmpeg developers and its dependency authors.\nThis is a separate command-line executable; AIScripter itself is MIT licensed.\n\nLinked source components: FFmpeg, x264 (GPLv2 or later), libvpx (BSD), Opus (BSD), zlib (zlib license).\nNo nonfree components or network protocols are enabled.\nThe matching third-party-sources.tar.gz is distributed with each AIScripter release:\nhttps://github.com/YvanLouise/aiscripter-for-ani/releases\nIt includes the complete source archives, licenses, build scripts, source identities, checksums and toolchain report.\n\nRebuild on Ubuntu 24.04 with Node.js 22 and these packages:\nsudo apt-get install mingw-w64 gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 nasm autoconf automake libtool pkg-config make\nExtract third-party-sources.tar.gz and change directory to corresponding-source.\nmkdir -p .build/ffmpeg/source-archives\ncp archives/* .build/ffmpeg/source-archives/\nbash scripts/build-ffmpeg.sh\nThe generated Windows binary is .build/ffmpeg/runtime/ffmpeg.exe.\n`;
await fs.writeFile(path.join(base, 'runtime/README.txt'), notice);
await fs.writeFile(path.join(base, 'corresponding-source/README.txt'), notice);
for (const [name, file] of [['x264', 'COPYING'], ['vpx', 'LICENSE'], ['opus', 'COPYING'], ['zlib', 'LICENSE']]) {
  await fs.copyFile(path.join(base, 'work', name, file), path.join(base, 'runtime', `${name}-LICENSE.txt`));
}
for (const name of ['mingw-w64-common', 'gcc-mingw-w64-base']) {
  const destination = `${name}-COPYRIGHT.txt`;
  await fs.copyFile(`/usr/share/doc/${name}/copyright`, path.join(base, 'runtime', destination));
  await fs.copyFile(`/usr/share/doc/${name}/copyright`, path.join(base, 'corresponding-source', destination));
}
const binary = await fs.readFile(path.join(base, 'runtime/ffmpeg.exe'));
await fs.writeFile(path.join(base, 'runtime/manifest.json'), JSON.stringify({ version: '9.0.2', license: 'GPL-3.0-or-later', sha256: createHash('sha256').update(binary).digest('hex'), sources }, null, 2));

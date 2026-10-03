#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$ROOT/.build/ffmpeg"
PREFIX="$BASE/prefix"
CROSS=x86_64-w64-mingw32-
JOBS="${BUILD_JOBS:-$(nproc)}"
export CC="${CROSS}gcc" CXX="${CROSS}g++" AR="${CROSS}ar" RANLIB="${CROSS}ranlib" STRIP="${CROSS}strip"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
node "$ROOT/scripts/fetch-ffmpeg-sources.mjs"
mkdir -p "$BASE/work" "$PREFIX" "$BASE/runtime" "$BASE/corresponding-source"
for library in zlib x264 vpx opus ffmpeg; do
  mkdir -p "$BASE/work/$library"
  tar -xzf "$BASE/source-archives/$library.tar.gz" --strip-components=1 -C "$BASE/work/$library"
done

cd "$BASE/work/zlib"
./configure --static --prefix="$PREFIX"
make -j"$JOBS"
make install

cd "$BASE/work/x264"
./configure --host=x86_64-w64-mingw32 --cross-prefix="$CROSS" --prefix="$PREFIX" --enable-static --disable-cli --disable-opencl --disable-lavf --disable-swscale
make -j"$JOBS"
make install

cd "$BASE/work/vpx"
CROSS="$CROSS" ./configure --target=x86_64-win64-gcc --prefix="$PREFIX" --enable-static --disable-shared --disable-examples --disable-tools --disable-docs --disable-unit-tests --enable-vp9-highbitdepth
make -j"$JOBS"
make install

cd "$BASE/work/opus"
./autogen.sh
./configure --host=x86_64-w64-mingw32 --prefix="$PREFIX" --enable-static --disable-shared --disable-doc --disable-extra-programs
make -j"$JOBS"
make install

cd "$BASE/work/ffmpeg"
./configure --arch=x86_64 --target-os=mingw32 --cross-prefix="$CROSS" \
  --pkg-config=pkg-config --pkg-config-flags=--static --prefix="$PREFIX" \
  --disable-autodetect --disable-network --disable-shared --enable-static --disable-debug --disable-doc --disable-ffplay --disable-ffprobe \
  --enable-gpl --enable-version3 --enable-libx264 --enable-libvpx --enable-libopus --enable-zlib \
  --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib -static -static-libgcc -static-libstdc++" \
  --disable-encoders --enable-encoder=libx264,libvpx_vp8,libvpx_vp9,libopus,aac,png,gif,pcm_s16le,pcm_f32le,rawvideo,wrapped_avframe
make -j"$JOBS" ffmpeg.exe
"${CROSS}strip" ffmpeg.exe
cp ffmpeg.exe "$BASE/runtime/ffmpeg.exe"
cp COPYING.GPLv3 "$BASE/runtime/COPYING.GPLv3"
cp ffbuild/config.mak "$BASE/runtime/build-config.txt"
mkdir -p "$BASE/corresponding-source/archives" "$BASE/corresponding-source/scripts" "$BASE/corresponding-source/build-resources"
cp "$BASE/source-archives/"* "$BASE/corresponding-source/archives/"
cp "$ROOT/scripts/build-ffmpeg.sh" "$ROOT/scripts/fetch-ffmpeg-sources.mjs" "$ROOT/scripts/ffmpeg-manifest.mjs" "$BASE/corresponding-source/scripts/"
cp "$ROOT/build-resources/ffmpeg-sources.json" "$BASE/corresponding-source/build-resources/"
cp ffbuild/config.mak "$BASE/corresponding-source/ffmpeg-config.mak"
{
  "$CC" --version
  nasm --version
  uname -a
  dpkg-query -W gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 mingw-w64 nasm autoconf automake libtool
} > "$BASE/corresponding-source/toolchain.txt"
node "$ROOT/scripts/ffmpeg-manifest.mjs"
tar -czf "$BASE/third-party-sources.tar.gz" -C "$BASE" corresponding-source
printf 'Built isolated GPLv3 FFmpeg with matching source archives.\n'

# pi-extension-gba — vendored mgba-wasm build
#
# Reproducible build of the two vendor patches on top of
# thenick775/mgba @ be30a34e913da1ba7f040d3db4e10f700ce49f76 (feature/wasm).
#
# Produces /out/mgba.js, /out/mgba.wasm, /out/mgba.d.ts, /out/mgba.wasm.map
# which `build.sh` copies into ./dist/.
#
# Pinned to emscripten/emsdk:4.0.4, matching upstream's docker/Dockerfile
# so we inherit the toolchain the fork was tested against.

FROM emscripten/emsdk:4.0.4

ARG MGBA_SHA=be30a34e913da1ba7f040d3db4e10f700ce49f76

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        make cmake git ca-certificates patch && \
    apt-get autoremove -y && apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Clone pinned upstream commit. Shallow to keep image small; --no-checkout
# then fetch-that-sha pattern lets us pin without relying on a branch tip.
RUN git clone https://github.com/thenick775/mgba.git /src && \
    git -C /src checkout "${MGBA_SHA}" && \
    git -C /src rev-parse HEAD

# Apply vendor patches. Order matters: 0001 edits CMakeLists, 0002 touches
# main.c / pre.js / mgba.d.ts, 0003 loosens the mGBA factory canvas type,
# 0004 strips SDL2 and rewrites main.c + CMakeLists around mcore directly
# (ADR 0002).
COPY patches/0001-add-node-environment.patch /tmp/0001.patch
COPY patches/0002-export-getPixelBuffer.patch /tmp/0002.patch
COPY patches/0003-loosen-canvas-type.patch /tmp/0003.patch
COPY patches/0004-strip-sdl.patch /tmp/0004.patch
COPY patches/0005-mcore-audio.patch /tmp/0005.patch
COPY patches/0006-export-malloc-heap16.patch /tmp/0006.patch

RUN cd /src && \
    patch -p1 --verbose < /tmp/0001.patch && \
    patch -p1 --verbose < /tmp/0002.patch && \
    patch -p1 --verbose < /tmp/0003.patch && \
    patch -p1 --verbose < /tmp/0004.patch && \
    patch -p1 --verbose < /tmp/0005.patch && \
    patch -p1 --verbose < /tmp/0006.patch

# Build. Upstream's build-wasm layout (see src/platform/wasm/package.json
# "build" script and docker/Dockerfile) does an out-of-tree build in
# build-wasm/ at repo root.
ENV BUILD_DIR=/src/build-wasm
RUN mkdir -p "${BUILD_DIR}" && \
    cd "${BUILD_DIR}" && \
    emcmake cmake .. \
        -DBUILD_STATIC=ON \
        -DBUILD_SHARED=OFF \
        -DBUILD_GL=OFF \
        -DBUILD_GLES2=OFF \
        -DUSE_EPOXY=OFF \
        -DUSE_FFMPEG=OFF \
        -DUSE_LIBZIP=OFF \
        -DUSE_MINIZIP=OFF \
        -DUSE_LZMA=OFF \
        -DUSE_SQLITE3=OFF \
        -DUSE_ELF=OFF \
        -DUSE_DISCORD_RPC=OFF \
        -DBUILD_QT=OFF \
        -DBUILD_SDL=OFF && \
    make -j"$(nproc)"

# Collect artefacts.
RUN mkdir -p /out && \
    cp /src/build-wasm/wasm/mgba.js       /out/mgba.js && \
    cp /src/build-wasm/wasm/mgba.wasm     /out/mgba.wasm && \
    cp /src/build-wasm/wasm/mgba.d.ts     /out/mgba.d.ts && \
    cp /src/build-wasm/wasm/mgba.wasm.map /out/mgba.wasm.map || true && \
    ls -la /out

# Default: print where the artefacts are. `build.sh` bind-mounts /out.
CMD ["sh", "-c", "ls -la /out && cat /out/mgba.js | head -5"]

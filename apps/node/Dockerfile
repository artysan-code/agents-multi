# The server node (ADR 0012): `agents serve --headless` as an unprivileged user, with the Bash sandbox of
# Claude Code (bubblewrap) working inside the container. Built with the repository's root as context:
#   docker build -f apps/node/Dockerfile -t agents-multi-node .
# Run it with the settings of compose.yaml (a seccomp profile, systempaths, an AppArmor profile): without
# them the sandbox cannot start and the node takes no job (failing closed). README.md has the steps.
# Images pinned by digest: a tag can be moved, a digest cannot (refresh the tag and digest together).

# The code, in the layout of the desktop app's package (apps/desktop/scripts/bundle.sh): the source with a
# build.json, and a Deno cache of every module it imports, so the first start downloads nothing.
FROM denoland/deno:2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432 AS code
WORKDIR /src
COPY deno.json deno.lock CHANGELOG.md LICENSE THIRD_PARTY_NOTICES.md ./
COPY apps/cli apps/cli
COPY apps/brain apps/brain
COPY shared shared
COPY bin bin
COPY desktop desktop
COPY config.example config.example
COPY pkg pkg
RUN rm -rf apps/cli/tests apps/brain/tests \
  && version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' deno.json | head -n1)" \
  && digest="$(find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)" \
  && printf '{"version":"%s","commit":"image","digest":"%s"}\n' "$version" "$digest" > build.json \
  && mkdir -p /out && cp -a /src /out/repo
ENV DENO_DIR=/out/deno-dir
RUN cd /out/repo && deno cache --quiet --frozen apps/cli/main.ts \
  && for server in shared/mcp/*/server.ts; do \
    lock="$(dirname "$server")/deno.lock"; \
    if [ -f "$lock" ]; then deno cache --quiet --no-config --frozen --lock="$lock" "$server"; \
    else deno cache --quiet --no-config "$server"; fi; \
  done \
  && rm -rf "$DENO_DIR/gen" "$DENO_DIR"/*_cache_v*

# whisper.cpp for voice notes (ADR 0014): `whisper-cli`, CPU only, built from a pinned commit (v1.9.5) as one static
# program, portable across CPUs (no -march=native) and with no OpenMP runtime to carry. The speech model is not in the
# image: `agents node setup` offers to download one into the volume and checks its SHA-256.
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS whisper
ARG WHISPER_CPP_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git init /src && cd /src \
  && git fetch --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER_CPP_COMMIT" \
  && git checkout --quiet FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "$WHISPER_CPP_COMMIT" \
  && cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_BUILD_EXAMPLES=ON \
  && cmake --build build -j"$(nproc)" --target whisper-cli \
  && strip build/bin/whisper-cli \
  && test -x build/bin/whisper-cli

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

# bubblewrap and socat: Claude Code's Bash sandbox (the filesystem and the network); git and ssh: the clones and
# the branches agentd pushes; iproute2: the node checks with `ss` that nothing of ours listens beyond loopback;
# jq and python3: the launchers and bin/agents read the brain's host from accounts.json; ffmpeg: a voice note's
# recording to the WAV whisper.cpp reads.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap socat git openssh-client ca-certificates curl \
    iproute2 procps jq python3-minimal ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Node, for Claude Code (>= 22) and the third-party MCP servers `agents install` pulls in: the official build of
# the active LTS, pinned and checked, not Debian's (Node 20, past its end of life, and npm with a pile of node-*
# packages). Moving it: the version and both checksums from https://nodejs.org/dist/v<version>/SHASUMS256.txt.
ARG NODE_VERSION=24.22.0
ARG NODE_SHA256_X64=28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c
ARG NODE_SHA256_ARM64=b7e7991d5407815adfa74a2a9cd4db683552c8ce32ff4a295c22e972849c3f5d
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      amd64) arch=x64; sum="$NODE_SHA256_X64" ;; \
      arm64) arch=arm64; sum="$NODE_SHA256_ARM64" ;; \
      *) echo "no Node build for $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && file="node-v${NODE_VERSION}-linux-${arch}.tar.gz" \
  && curl -fsSLo "/tmp/$file" "https://nodejs.org/dist/v${NODE_VERSION}/$file" \
  && echo "$sum  /tmp/$file" | sha256sum -c - \
  && tar -xzf "/tmp/$file" -C /usr/local --strip-components=1 --no-same-owner \
    --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' --exclude='*/include' --exclude='*/share' \
  && rm "/tmp/$file" \
  && node --version && npm --version

COPY --from=denoland/deno:bin-2.9.7@sha256:bc5aa4466e21b6d3021226a85ba2e1911f7c386254d97b9d797903ab74edace2 /deno /usr/local/bin/deno

# Claude Code at the version the setup was measured with.
ARG CLAUDE_CODE_VERSION=2.1.300
RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && claude --version

COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=code /out /opt/agents-multi
COPY apps/node/entrypoint.sh /opt/agents-multi/entrypoint.sh
COPY apps/node/probe.sh /usr/local/bin/node-probe
RUN chmod 0755 /opt/agents-multi/entrypoint.sh /usr/local/bin/node-probe \
  && ln -s /opt/agents-multi/repo/bin/agents /usr/local/bin/agents \
  && useradd --uid 1000 --create-home --home-dir /home/agent --shell /bin/bash agent

USER 1000:1000
WORKDIR /home/agent
# the runtime (~/.agents-multi), the configuration, the Claude logins, the clones, the git key and the vault key
# file all live under the home: one volume
ENV HOME=/home/agent \
  AGENTS_MULTI_DENO=/usr/local/bin/deno \
  PATH=/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin
VOLUME /home/agent
# the console listens on loopback only (7331): the probe is a connection to it, over bash's /dev/tcp
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=120s CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/7331"]
ENTRYPOINT ["/opt/agents-multi/entrypoint.sh"]

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

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

# bubblewrap and socat: Claude Code's Bash sandbox (the filesystem and the network); git and ssh: the clones and
# the branches agentd pushes; iproute2: the node checks with `ss` that nothing of ours listens beyond loopback;
# jq and python3: the launchers and bin/agents read the brain's host from accounts.json; nodejs and npm: Claude Code and the
# third-party MCP servers that `agents install` pulls in.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap socat git openssh-client ca-certificates curl \
    iproute2 procps jq python3-minimal nodejs npm \
  && rm -rf /var/lib/apt/lists/*

COPY --from=denoland/deno:bin-2.9.7@sha256:bc5aa4466e21b6d3021226a85ba2e1911f7c386254d97b9d797903ab74edace2 /deno /usr/local/bin/deno

# Claude Code at the version the setup was measured with; its native binary needs no Node at run time.
ARG CLAUDE_CODE_VERSION=2.1.300
RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && claude --version

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

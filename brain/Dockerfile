# The brain service. Built from the repository root, so it can take the task rules it shares with
# the local tools (shared/mcp/lib/tasks.ts, shared/mcp/tasks/tools.ts) and claude-multi's site:
#   docker build -f brain/Dockerfile .

# claude-multi's site (site/, Astro): built here, served by the brain from site/dist
# images pinned by digest: a tag can be moved, a digest cannot (refresh both together)
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS site
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /site
COPY site/package.json site/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY site/ ./
RUN pnpm build

FROM denoland/deno:2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432

WORKDIR /app
COPY brain/ brain/
COPY shared/mcp/lib/tasks.ts shared/mcp/lib/mask.ts shared/mcp/lib/owner.ts shared/mcp/lib/
COPY shared/mcp/tasks/tools.ts shared/mcp/tasks/tools.ts
COPY --from=site /site/dist site/dist
RUN deno cache brain/main.ts

RUN mkdir -p /data && chown deno:deno /data
USER deno
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["deno", "eval", "const r = await fetch('http://127.0.0.1:8080/health'); if (!r.ok) Deno.exit(1)"]
# reads only its code, the site, its cache and its data
CMD ["run", "--allow-net", "--allow-env", "--allow-read=/app,/data,/deno-dir", "--allow-write=/data", "brain/main.ts"]

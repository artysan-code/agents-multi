# The brain service. Built with the repository root as context, so it can take the task rules it
# shares with the local tools (shared/mcp/lib/tasks.ts, shared/mcp/tasks/tools.ts) and the site:
#   docker build -f apps/brain/Dockerfile .
# Inside the image the files keep their repository paths under /app, so relative imports hold.

# agents-multi's site (apps/site, Astro): built here, served by the brain from apps/site/dist
# images pinned by digest: a tag can be moved, a digest cannot (refresh both together)
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS site
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /site
COPY apps/site/package.json apps/site/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/site/ ./
# the docs' Changelog page is written from it (apps/site/scripts/changelog.mjs)
COPY CHANGELOG.md /CHANGELOG.md
RUN pnpm build

FROM denoland/deno:2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432

WORKDIR /app
COPY apps/brain/ apps/brain/
COPY shared/mcp/lib/tasks.ts shared/mcp/lib/mask.ts shared/mcp/lib/owner.ts shared/mcp/lib/env.ts shared/mcp/lib/
COPY shared/mcp/tasks/tools.ts shared/mcp/tasks/tools.ts
COPY --from=site /site/dist apps/site/dist
RUN deno cache apps/brain/main.ts apps/brain/admin.ts apps/brain/site.ts
# `brain-admin <command>` in a shell of the container: apps/brain/admin.ts with the service's own permissions
RUN printf '#!/bin/sh\nexec deno run --allow-net=127.0.0.1 --allow-env --allow-read=/app,/data,/deno-dir --allow-write=/data /app/apps/brain/admin.ts "$@"\n' > /usr/local/bin/brain-admin \
  && chmod +x /usr/local/bin/brain-admin

RUN mkdir -p /data && chown deno:deno /data
USER deno
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s CMD ["deno", "eval", "const r = await fetch('http://127.0.0.1:8080/ready'); if (!r.ok) Deno.exit(1)"]
# reads only its code, the site, its cache and its data
CMD ["run", "--allow-net", "--allow-env", "--allow-read=/app,/data,/deno-dir", "--allow-write=/data", "apps/brain/main.ts"]

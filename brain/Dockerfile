# The brain service. Built from the repository root, so it can take the task rules it shares with
# the local tools (shared/mcp/lib/tasks.ts, shared/mcp/tasks/tools.ts) and claude-multi's site:
#   docker build -f brain/Dockerfile .

# claude-multi's site (site/, Astro): built here, served by the brain from site/dist
FROM node:22-alpine AS site
RUN corepack enable
WORKDIR /site
COPY site/package.json site/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY site/ ./
RUN pnpm build

FROM denoland/deno:2.9.7

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
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write=/data", "brain/main.ts"]

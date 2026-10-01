# The brain service. Built from the repository root, so it can take the task rules it shares with
# the local tools (shared/mcp/lib/tasks.ts, shared/mcp/tasks/tools.ts):
#   docker build -f brain/Dockerfile .
FROM denoland/deno:2.9.7

WORKDIR /app
COPY brain/ brain/
COPY shared/mcp/lib/tasks.ts shared/mcp/lib/tasks.ts
COPY shared/mcp/tasks/tools.ts shared/mcp/tasks/tools.ts
RUN deno cache brain/main.ts

RUN mkdir -p /data && chown deno:deno /data
USER deno
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["deno", "eval", "const r = await fetch('http://127.0.0.1:8080/health'); if (!r.ok) Deno.exit(1)"]
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write=/data", "brain/main.ts"]

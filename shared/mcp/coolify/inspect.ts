// coolify — inspect: resources, details, logs, deploy history, variables, SSH keys.
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@4.6.5";
import {
  account,
  api,
  API_PATH,
  deploymentId,
  find,
  findApp,
  findOfKind,
  type Kind,
  kindArg,
  type Loose,
  READS,
} from "./api.ts";
import { HIDDEN, mask, maskDeep, maskText } from "../lib/mask.ts";
import { text as txt } from "../lib/service.ts";

export function register(server: McpServer) {
  server.registerTool("coolify_resources", {
    description:
      "Overview of what runs on Coolify: servers, projects, applications (with domain and status), services (multi-container compose stacks) and managed databases. The starting point when the contents of an instance are unknown.",
    inputSchema: { account },
    annotations: READS,
  }, async ({ account }: { account?: string }) => {
    const [servers, projects, apps, services, db] = await Promise.all([
      api(account, "/servers"),
      api(account, "/projects"),
      api(account, "/applications"),
      api(account, "/services"),
      api(account, "/databases"),
    ]) as Loose[][];
    return txt({
      servers: servers.map((s) => ({ uuid: s.uuid, name: s.name, ip: s.ip, reachable: s.is_reachable })),
      projects: projects.map((p) => ({ uuid: p.uuid, name: p.name })),
      applications: apps.map((a) => ({
        uuid: a.uuid,
        name: a.name,
        domain: a.fqdn ?? null,
        status: a.status,
        branch: a.git_branch,
        build_pack: a.build_pack,
      })),
      services: services.map((v) => ({ uuid: v.uuid, name: v.name, status: v.status })),
      databases: db.map((d) => ({ uuid: d.uuid, name: d.name, engine: d.database_type, status: d.status })),
    });
  });

  server.registerTool("coolify_version", {
    description: "Returns the Coolify instance version and its health-check response.",
    inputSchema: { account },
    annotations: READS,
  }, async ({ account }: { account?: string }) => {
    const [version, health] = await Promise.all([
      api(account, "/version"),
      api(account, "/health").catch((e) => (e as Error).message),
    ]);
    return txt({ version, health });
  });

  server.registerTool("coolify_detail", {
    description:
      "Returns the detail of one resource, by uuid or name: application (git source, build, domains, health check, limits), service (compose, containers, domains), " +
      "database (image, ports, backups), server (resources running on it, domains) or project (environments and their contents). Secret values are masked.",
    inputSchema: {
      account,
      kind: z.enum(["application", "service", "database", "server", "project"]),
      ref: z.string().describe("uuid or name"),
    },
    annotations: READS,
  }, async ({ account, kind, ref }: { account?: string; kind: Kind | "server" | "project"; ref: string }) => {
    if (kind === "application") {
      const a = await api(account, `/applications/${(await findApp(account, ref)).uuid}`) as Loose;
      return txt(maskDeep({
        uuid: a.uuid,
        name: a.name,
        description: a.description,
        status: a.status,
        domain: a.fqdn,
        compose_domains: a.docker_compose_domains,
        git: {
          repository: a.git_repository,
          branch: a.git_branch,
          commit: a.git_commit_sha,
          auto_deploy: a.is_auto_deploy_enabled,
        },
        build: {
          build_pack: a.build_pack,
          base_directory: a.base_directory,
          dockerfile: a.dockerfile_location,
          compose: a.docker_compose_location,
          image: a.docker_registry_image_name
            ? `${a.docker_registry_image_name}:${a.docker_registry_image_tag ?? "latest"}`
            : null,
          install: a.install_command,
          build: a.build_command,
          start: a.start_command,
          watch_paths: a.watch_paths,
        },
        ports: { exposed: a.ports_exposes, mapped: a.ports_mappings },
        health: { enabled: a.health_check_enabled, path: a.health_check_path, port: a.health_check_port },
        limits: { memory: a.limits_memory, cpu: a.limits_cpus },
        // Webhook secrets are always present: only the fact that they are configured is reported.
        webhooks_configured: Object.keys(a).filter((k) => k.startsWith("manual_webhook_secret_") && a[k]),
      }));
    }
    if (kind === "service") {
      const s = await api(account, `/services/${(await findOfKind(account, "service", ref)).uuid}`) as Loose;
      return txt({
        uuid: s.uuid,
        name: s.name,
        description: s.description,
        status: s.status,
        containers: [...(s.applications ?? []), ...(s.databases ?? [])].map((c: Loose) => ({
          uuid: c.uuid,
          name: c.name,
          status: c.status,
          domain: c.fqdn ?? null,
          image: c.image,
        })),
        compose: s.docker_compose_raw ? maskText(s.docker_compose_raw) : null,
      });
    }
    if (kind === "database") {
      const d = await api(account, `/databases/${(await findOfKind(account, "database", ref)).uuid}`) as Loose;
      const backups = await api(account, `/databases/${d.uuid}/backups`).catch(() => []) as Loose[];
      return txt(maskDeep({
        uuid: d.uuid,
        name: d.name,
        engine: d.database_type,
        status: d.status,
        image: d.image,
        public: d.is_public,
        public_port: d.public_port,
        limits: { memory: d.limits_memory, cpu: d.limits_cpus },
        internal_url: d.internal_db_url ? maskText(d.internal_db_url) : null,
        backups: backups.map((b) => ({ uuid: b.uuid, schedule: b.frequency, enabled: b.enabled, s3: b.save_s3 })),
      }));
    }
    if (kind === "server") {
      const s = await find(account, "/servers", "server", ref);
      const [resources, domains] = await Promise.all([
        api(account, `/servers/${s.uuid}/resources`).catch(() => []),
        api(account, `/servers/${s.uuid}/domains`).catch(() => []),
      ]) as Loose[][];
      return txt({
        uuid: s.uuid,
        name: s.name,
        ip: s.ip,
        reachable: s.is_reachable,
        usable: s.is_usable,
        proxy: s.proxy?.type ?? s.proxy_type,
        resources: resources.map((r) => ({ uuid: r.uuid, name: r.name, type: r.type, status: r.status })),
        domains,
      });
    }
    const p = await find(account, "/projects", "project", ref);
    const envs = await api(account, `/projects/${p.uuid}/environments`) as Loose[];
    const contents = await Promise.all(envs.map(async (e) => {
      const x = await api(account, `/projects/${p.uuid}/${e.uuid}`).catch(() => ({})) as Loose;
      const names = (k: string) => (x[k] ?? []).map((r: Loose) => r.name);
      return {
        environment: e.name,
        uuid: e.uuid,
        applications: names("applications"),
        services: names("services"),
        databases: [
          ...names("postgresqls"),
          ...names("redis"),
          ...names("mysqls"),
          ...names("mariadbs"),
          ...names("mongodbs"),
        ],
      };
    }));
    return txt({ uuid: p.uuid, name: p.name, description: p.description, environments: contents });
  });

  server.registerTool(
    "coolify_logs",
    {
      description:
        "Returns the last log lines of an application, a service (all containers, or one given by `container`) or a database. " +
        "Secret values in the lines are masked.",
      inputSchema: {
        account,
        kind: kindArg,
        ref: z.string().describe("uuid or name"),
        lines: z.number().int().min(1).max(1000).optional().describe("default 100"),
        container: z.string().optional().describe("for a service: the service name in the compose file"),
      },
      annotations: READS,
    },
    async (
      { account, kind, ref, lines, container }: {
        account?: string;
        kind: Kind;
        ref: string;
        lines?: number;
        container?: string;
      },
    ) => {
      const r = await findOfKind(account, kind, ref);
      const n = lines ?? 100;
      const read = async (sub?: string) => {
        const q = new URLSearchParams({ lines: String(n) });
        if (sub) q.set("sub_service_name", sub);
        const l = await api(account, `${API_PATH[kind]}/${r.uuid}/logs?${q}`) as Loose;
        return maskText(String(typeof l === "string" ? l : l?.logs ?? JSON.stringify(l))).split("\n").slice(-n);
      };
      if (kind !== "service" || container) {
        return txt({
          resource: r.name,
          ...(container ? { container } : {}),
          logs: await read(container),
        });
      }
      // Coolify requires a container name: without one, every container of the service is read, keyed by name.
      const s = await api(account, `/services/${r.uuid}`) as Loose;
      const names = [...(s.applications ?? []), ...(s.databases ?? [])].map((c: Loose) => c.name as string);
      const logs = Object.fromEntries(
        await Promise.all(names.map(async (c) => [c, await read(c).catch((e) => [(e as Error).message])])),
      );
      return txt({ resource: r.name, logs });
    },
  );

  server.registerTool("coolify_env_vars", {
    description:
      "Lists the environment variables of an application, a service or a database. Values that look secret are masked.",
    inputSchema: {
      account,
      kind: kindArg.optional().describe("default application"),
      ref: z.string().describe("uuid or name"),
    },
    annotations: READS,
  }, async ({ account, kind, ref }: { account?: string; kind?: Kind; ref: string }) => {
    const k = kind ?? "application";
    const r = await findOfKind(account, k, ref);
    const envs = await api(account, `${API_PATH[k]}/${r.uuid}/envs`) as Loose[];
    return txt(
      envs
        .filter((e) => !e.is_preview) // preview copies are generated by Coolify itself: noise
        .map((e) => ({
          key: e.key,
          value: e.is_shown_once ? HIDDEN : mask(e.key, e.value),
          ...(e.is_build_time ? { build: true } : {}),
        })),
    );
  });

  server.registerTool("coolify_deploy_history", {
    description:
      "Lists the latest deployments of an application: time, commit and outcome. For the logs of one deployment, use coolify_deploy_status.",
    inputSchema: {
      account,
      application: z.string().describe("uuid or name"),
      limit: z.number().int().min(1).max(50).optional().describe("default 10"),
    },
    annotations: READS,
  }, async ({ account, application, limit }: { account?: string; application: string; limit?: number }) => {
    const a = await findApp(account, application);
    const r = await api(account, `/deployments/applications/${a.uuid}?take=${limit ?? 10}`) as Loose;
    const list = (Array.isArray(r) ? r : r?.deployments ?? []) as Loose[];
    return txt(
      list.map((d) => ({
        deployment: d.deployment_uuid,
        status: d.status,
        commit: d.commit?.slice?.(0, 10) ?? null,
        message: d.commit_message ?? null,
        started: d.created_at,
        finished: d.updated_at,
      })),
    );
  });

  server.registerTool("coolify_deploy_status", {
    description:
      "Returns the status of a deployment. When the deployment has finished, also returns the tail of its logs (Coolify nests them as JSON inside JSON), which is where a failure reason is found.",
    inputSchema: {
      account,
      deployment: deploymentId.describe("identifier returned by coolify_deploy"),
      lines: z.number().optional().describe("number of log lines (default 25, only once finished)"),
    },
    annotations: READS,
  }, async ({ account, deployment, lines }: { account?: string; deployment: string; lines?: number }) => {
    const d = await api(account, `/deployments/${deployment}`) as Loose;
    const status = d?.status;
    const result: Record<string, unknown> = { status, application: d?.application_name };
    if (status !== "in_progress" && status !== "queued") {
      try {
        const entries = JSON.parse(d?.logs ?? "[]") as Loose[];
        result.logs = entries.map((v) => v.output).filter(Boolean).slice(-(lines ?? 25)).map((l: string) =>
          maskText(l)
        );
      } catch {
        result.logs = "logs not readable";
      }
    }
    return txt(result);
  });

  server.registerTool("coolify_keys", {
    description:
      "Lists the private SSH keys stored in Coolify, by name and uuid (never the content). Used to create an application from a private repository with a deploy key.",
    inputSchema: { account },
    annotations: READS,
  }, async ({ account }: { account?: string }) => {
    const k = await api(account, "/security/keys") as Loose[];
    return txt(
      k.map((x) => ({ uuid: x.uuid, name: x.name, description: x.description ?? null, git: x.is_git_related ?? null })),
    );
  });
}

#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env --allow-run=/usr/bin/secret-tool
// coolify — MCP server for Coolify instances (accounts.json, service "coolify").
//
// Covers the whole lifecycle of what runs on Coolify: inspect (resources, details, logs, deploy
// history, environment variables, backups), create (projects, environments, applications from git
// or from an image, compose services, databases), change (configuration, domains, variables), run
// (deploy, start, stop, restart, scheduled tasks) and maintain (database backups, Docker cleanup
// on the server). Calls follow the Coolify 4 OpenAPI.
//
// No deletion is exposed, on purpose: destroying a resource is left to a manual action taken in
// Coolify itself.
//
// No secret travels through this server, in either direction. Responses are masked (lib/mask.ts:
// fields, logs, compose files); a variable with a reserved name or an address with embedded
// credentials is rejected on write; a created database returns only its uuid (Coolify answers with
// the clear-text password); for SSH keys only the name is shown, never the content.
//
// Accounts and tokens: shared/mcp/lib (accounts.json + vault). Every tool takes `account`, required
// only when the profile sees more than one instance. The token never goes through a tool.
import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.18/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.18/server/stdio.js";
import { z } from "npm:zod@^3.23";
import { CREDENTIALS_IN_URL, HIDDEN, mask, maskDeep, maskText, SECRET_NAME } from "../lib/mask.ts";
import { service, text as txt } from "../lib/service.ts";

const coolify = service("coolify");

/**
 * Calls the Coolify REST API (`/api/v1` + `path`) with the account's token.
 * Returns the parsed JSON body, or the raw text when the body is not JSON.
 * Throws on a non-2xx status, with the path (query stripped) and the masked start of the body.
 */
async function api(account: string | undefined, path: string, init?: RequestInit): Promise<unknown> {
  const { account: a, secret } = await coolify.use(account);
  const r = await fetch(`${a.url}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${path.split("?")[0]} → HTTP ${r.status}: ${maskText(body.slice(0, 400))}`);
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
const post = (account: string | undefined, path: string, body?: unknown) =>
  api(account, path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const patch = (account: string | undefined, path: string, body: unknown) =>
  api(account, path, { method: "PATCH", body: JSON.stringify(body) });

// deno-lint-ignore no-explicit-any -- Coolify responses have no schema that is stable across versions
type Loose = any;
type Kind = "application" | "service" | "database";
const API_PATH: Record<Kind, string> = { application: "/applications", service: "/services", database: "/databases" };

/**
 * Resolves a resource in the list at `listPath` by uuid, then exact name, then name substring
 * (case-insensitive). `what` names the resource type in the error, which lists the candidates.
 */
async function find(account: string | undefined, listPath: string, what: string, ref: string): Promise<Loose> {
  const all = await api(account, listPath) as Loose[];
  const match = all.find((a) => a.uuid === ref) ??
    all.find((a) => String(a.name ?? "").toLowerCase() === ref.toLowerCase()) ??
    all.find((a) => String(a.name ?? "").toLowerCase().includes(ref.toLowerCase()));
  if (!match) {
    const names = all.map((a) => `${a.name} (${a.uuid})`).join(", ") || "none";
    throw new Error(`no ${what} matches "${ref}". Available: ${names}`);
  }
  return match;
}
const findApp = (account: string | undefined, ref: string) => find(account, "/applications", "application", ref);
const findOfKind = (account: string | undefined, kind: Kind, ref: string) => find(account, API_PATH[kind], kind, ref);

/** The server to create resources on: the instance's only one. Throws when there is not exactly one. */
async function soleServer(account: string | undefined): Promise<Loose> {
  const servers = await api(account, "/servers") as Loose[];
  if (servers.length !== 1) throw new Error(`the server must be chosen: the instance has ${servers.length}`);
  return servers[0];
}

/**
 * Resolves a project and one of its environments (by name or uuid) to the identifiers that the
 * create endpoints require.
 */
async function locate(account: string | undefined, project: string, environment = "production") {
  const p = await find(account, "/projects", "project", project);
  const envs = await api(account, `/projects/${p.uuid}/environments`) as Loose[];
  const e = envs.find((x) => x.uuid === environment || String(x.name).toLowerCase() === environment.toLowerCase());
  if (!e) {
    throw new Error(`no environment "${environment}" in ${p.name}. Available: ${envs.map((x) => x.name).join(", ")}`);
  }
  return { project_uuid: p.uuid, environment_name: e.name, environment_uuid: e.uuid, project: p.name };
}

/** Throws when a key/value pair to be written looks like a secret (reserved name or credentials in a URL). */
function assertNotSecret(key: string, value: string) {
  if (SECRET_NAME.test(key) || CREDENTIALS_IN_URL.test(value)) {
    throw new Error(
      `"${key}" looks like a secret: set it from the Coolify panel. A secret passed through here ends up in the conversation context.`,
    );
  }
}

const server = new McpServer({ name: "coolify", version: "0.4.0" });
const account = coolify.accountArg;
const kindArg = z.enum(["application", "service", "database"]);
const READS = { readOnlyHint: true, openWorldHint: true };
const CHANGES = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

// ============================================================ inspect

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
    deployment: z.string().describe("identifier returned by coolify_deploy"),
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
      result.logs = entries.map((v) => v.output).filter(Boolean).slice(-(lines ?? 25)).map((l: string) => maskText(l));
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

// ============================================================ create

server.registerTool("coolify_create_project", {
  description:
    'Creates a project; Coolify creates its "production" environment itself. When a project with the same name already exists, returns it instead of creating a duplicate.',
  inputSchema: { account, name: z.string(), description: z.string().optional() },
  annotations: CHANGES,
}, async ({ account, name, description }: { account?: string; name: string; description?: string }) => {
  const projects = await api(account, "/projects") as Loose[];
  const existing = projects.find((p) => String(p.name).toLowerCase() === name.toLowerCase());
  if (existing) return txt({ project: existing.uuid, name: existing.name, created: false });
  const r = await post(account, "/projects", {
    name,
    ...(description ? { description } : {}),
  }) as Loose;
  return txt({ project: r.uuid, name, created: true, environment: "production" });
});

server.registerTool("coolify_create_environment", {
  description: "Adds an environment (staging, test, ...) to a project. When it already exists, returns it.",
  inputSchema: { account, project: z.string().describe("uuid or name"), name: z.string() },
  annotations: CHANGES,
}, async ({ account, project, name }: { account?: string; project: string; name: string }) => {
  const p = await find(account, "/projects", "project", project);
  const envs = await api(account, `/projects/${p.uuid}/environments`) as Loose[];
  const existing = envs.find((e) => String(e.name).toLowerCase() === name.toLowerCase());
  if (existing) return txt({ environment: existing.uuid, name: existing.name, created: false });
  const r = await post(account, `/projects/${p.uuid}/environments`, { name }) as Loose;
  return txt({ environment: r.uuid, name, project: p.name, created: true });
});

server.registerTool("coolify_create_application", {
  description:
    "Creates an application from a public git repository, from a private one with a deploy key stored in Coolify (see coolify_keys), or from a Docker image. " +
    "The build can be nixpacks, railpack, dockerfile, dockercompose or static. It is not started by default: review the configuration, then run coolify_deploy.",
  inputSchema: {
    account,
    project: z.string().describe("uuid or name"),
    environment: z.string().optional().describe("default production"),
    name: z.string(),
    description: z.string().optional(),
    source: z.enum(["git_public", "git_key", "image"]),
    repository: z.string().optional().describe(
      "for git: https://... (public) or git@host:owner/repo.git / ssh://git@host:port/owner/repo.git (with key)",
    ),
    branch: z.string().optional().describe("for git, default main"),
    key: z.string().optional().describe("for git_key: uuid or name of the key in Coolify"),
    build: z.enum(["nixpacks", "railpack", "dockerfile", "dockercompose", "static"]).optional().describe(
      "for git, default nixpacks",
    ),
    base_directory: z.string().optional().describe("default /"),
    dockerfile: z.string().optional().describe("path of the Dockerfile, default /Dockerfile"),
    compose: z.string().optional().describe(
      "path of the compose file for a dockercompose build, default /docker-compose.yaml",
    ),
    image: z.string().optional().describe("for image: the image name, e.g. ghcr.io/owner/app"),
    tag: z.string().optional().describe("for image, default latest"),
    ports: z.string().optional().describe("ports exposed by the container, e.g. 8080"),
    domain: z.string().optional().describe(
      "https://... (several domains separated by commas); not for dockercompose",
    ),
    compose_domains: z.array(z.object({ service: z.string(), domain: z.string() })).optional().describe(
      "for dockercompose: the domain of each service in the compose file",
    ),
    start: z.boolean().optional().describe("deploy right after creation (default no)"),
  },
  annotations: CHANGES,
}, async (a: {
  account?: string;
  project: string;
  environment?: string;
  name: string;
  description?: string;
  source: "git_public" | "git_key" | "image";
  repository?: string;
  branch?: string;
  key?: string;
  build?: string;
  base_directory?: string;
  dockerfile?: string;
  compose?: string;
  image?: string;
  tag?: string;
  ports?: string;
  domain?: string;
  compose_domains?: { service: string; domain: string }[];
  start?: boolean;
}) => {
  if (a.repository && CREDENTIALS_IN_URL.test(a.repository)) {
    throw new Error("the repository URL contains credentials: use a deploy key (source git_key)");
  }
  const w = await locate(a.account, a.project, a.environment);
  const s = await soleServer(a.account);
  const body: Record<string, unknown> = {
    project_uuid: w.project_uuid,
    environment_name: w.environment_name,
    environment_uuid: w.environment_uuid,
    server_uuid: s.uuid,
    name: a.name,
    ...(a.description ? { description: a.description } : {}),
    ...(a.ports ? { ports_exposes: a.ports } : {}),
    ...(a.domain ? { domains: a.domain } : {}),
    instant_deploy: a.start ?? false,
  };
  let path: string;
  if (a.source === "image") {
    if (!a.image) throw new Error("`image` is required");
    path = "/applications/dockerimage";
    Object.assign(body, { docker_registry_image_name: a.image, docker_registry_image_tag: a.tag ?? "latest" });
  } else {
    if (!a.repository) throw new Error("`repository` is required");
    Object.assign(body, {
      git_repository: a.repository,
      git_branch: a.branch ?? "main",
      build_pack: a.build ?? "nixpacks",
      ...(a.base_directory ? { base_directory: a.base_directory } : {}),
      ...(a.dockerfile ? { dockerfile_location: a.dockerfile } : {}),
      ...(a.compose ? { docker_compose_location: a.compose } : {}),
      ...(a.compose_domains?.length
        ? { docker_compose_domains: a.compose_domains.map((d) => ({ name: d.service, domain: d.domain })) }
        : {}),
    });
    if (a.source === "git_key") {
      if (!a.key) throw new Error("`key` is required (coolify_keys lists them)");
      body.private_key_uuid = (await find(a.account, "/security/keys", "key", a.key)).uuid;
      path = "/applications/private-deploy-key";
    } else path = "/applications/public";
  }
  const r = await post(a.account, path, body) as Loose;
  return txt({
    application: r.uuid,
    name: a.name,
    project: w.project,
    environment: w.environment_name,
    domains: r.domains ?? a.domain ?? null,
    started: body.instant_deploy,
  });
});

server.registerTool("coolify_create_service", {
  description:
    "Creates a service from a docker compose file inside a project and environment. It is not started by default. Secrets must not be written in the compose file: use Coolify's magic variables ($SERVICE_PASSWORD_<NAME>, $SERVICE_USER_<NAME>), which Coolify generates and which never pass through this server.",
  inputSchema: {
    account,
    project: z.string().describe("uuid or name of the project"),
    environment: z.string().optional().describe("environment name (default production)"),
    name: z.string(),
    description: z.string().optional(),
    compose: z.string().describe("the docker-compose file as plain YAML; the tool does the base64 encoding"),
    domains: z.array(z.object({
      container: z.string().describe("service name in the compose file"),
      url: z.string().describe("e.g. https://git.example.com"),
    })).optional(),
    start: z.boolean().optional().describe("start right after creation (default no)"),
  },
  annotations: CHANGES,
}, async (
  { account, project, environment, name, description, compose, domains, start }: {
    account?: string;
    project: string;
    environment?: string;
    name: string;
    description?: string;
    compose: string;
    domains?: { container: string; url: string }[];
    start?: boolean;
  },
) => {
  if (CREDENTIALS_IN_URL.test(compose)) {
    throw new Error(
      "the compose file contains credentials in a URL: use the $SERVICE_USER_* / $SERVICE_PASSWORD_* variables",
    );
  }
  const w = await locate(account, project, environment);
  const s = await soleServer(account);
  const body = {
    name,
    ...(description ? { description } : {}),
    project_uuid: w.project_uuid,
    environment_name: w.environment_name,
    environment_uuid: w.environment_uuid,
    server_uuid: s.uuid,
    docker_compose_raw: btoa(String.fromCodePoint(...new TextEncoder().encode(compose))),
    ...(domains?.length ? { urls: domains.map((d) => ({ name: d.container, url: d.url })) } : {}),
    instant_deploy: start ?? false,
  };
  // Only the uuid and the domains are kept from the response, in case a password is ever added to it.
  const r = await post(account, "/services", body) as Loose;
  return txt({
    service: r.uuid,
    project: w.project,
    environment: w.environment_name,
    domains: r.domains,
    started: body.instant_deploy,
  });
});

server.registerTool(
  "coolify_create_database",
  {
    description:
      "Creates a managed database (PostgreSQL, Redis, MariaDB, MySQL, MongoDB, KeyDB, DragonFly, ClickHouse). Coolify generates the credentials and keeps them in its panel: " +
      "only the uuid is returned. The database is not exposed publicly unless `public` is set.",
    inputSchema: {
      account,
      engine: z.enum(["postgresql", "redis", "mariadb", "mysql", "mongodb", "keydb", "dragonfly", "clickhouse"]),
      project: z.string().describe("uuid or name"),
      environment: z.string().optional(),
      name: z.string(),
      image: z.string().optional().describe("e.g. postgres:17-alpine; default is Coolify's"),
      memory: z.string().optional().describe("memory limit, e.g. 512m"),
      public: z.boolean().optional().describe("expose on a public port (default no)"),
      public_port: z.number().int().optional(),
      start: z.boolean().optional().describe("start right after creation (default no)"),
    },
    annotations: CHANGES,
  },
  async (
    a: {
      account?: string;
      engine: string;
      project: string;
      environment?: string;
      name: string;
      image?: string;
      memory?: string;
      public?: boolean;
      public_port?: number;
      start?: boolean;
    },
  ) => {
    const w = await locate(a.account, a.project, a.environment);
    const s = await soleServer(a.account);
    const r = await post(a.account, `/databases/${a.engine}`, {
      server_uuid: s.uuid,
      project_uuid: w.project_uuid,
      environment_name: w.environment_name,
      environment_uuid: w.environment_uuid,
      name: a.name,
      ...(a.image ? { image: a.image } : {}),
      ...(a.memory ? { limits_memory: a.memory } : {}),
      is_public: a.public ?? false,
      ...(a.public_port ? { public_port: a.public_port } : {}),
      instant_deploy: a.start ?? false,
    }) as Loose;
    // Coolify answers with the password and the full connection URL: only the uuid is kept.
    return txt({
      database: r.uuid,
      engine: a.engine,
      name: a.name,
      project: w.project,
      started: a.start ?? false,
      credentials: "in the Coolify panel",
    });
  },
);

// ============================================================ change

/** Application fields that can be changed through this server; secrets (basic auth, webhooks) are excluded. */
const APP_FIELDS = [
  "name",
  "description",
  "domains",
  "git_repository",
  "git_branch",
  "git_commit_sha",
  "build_pack",
  "base_directory",
  "publish_directory",
  "dockerfile_location",
  "docker_compose_location",
  "docker_compose_domains",
  "docker_registry_image_name",
  "docker_registry_image_tag",
  "ports_exposes",
  "ports_mappings",
  "install_command",
  "build_command",
  "start_command",
  "watch_paths",
  "is_auto_deploy_enabled",
  "is_force_https_enabled",
  "redirect",
  "health_check_enabled",
  "health_check_path",
  "health_check_port",
  "health_check_interval",
  "health_check_timeout",
  "health_check_retries",
  "health_check_start_period",
  "limits_memory",
  "limits_cpus",
  "pre_deployment_command",
  "pre_deployment_command_container",
  "post_deployment_command",
  "post_deployment_command_container",
  "custom_labels",
  "is_static",
  "is_spa",
  "disable_build_cache",
  "docker_images_to_keep",
  "stop_grace_period",
];

server.registerTool(
  "coolify_update_application",
  {
    description:
      "Changes an application's configuration: domains, branch, Dockerfile or compose paths, ports, commands, health check, limits, auto deploy, etc. " +
      `Fields use the Coolify API names (${
        APP_FIELDS.join(", ")
      }). A deploy is required for the change to take effect.`,
    inputSchema: {
      account,
      application: z.string().describe("uuid or name"),
      fields: z.record(z.unknown()).describe('e.g. { "domains": "https://app.example.com", "git_branch": "release" }'),
    },
    annotations: CHANGES,
  },
  async (
    { account, application, fields }: { account?: string; application: string; fields: Record<string, unknown> },
  ) => {
    const rejected = Object.keys(fields).filter((k) => !APP_FIELDS.includes(k));
    if (rejected.length) {
      throw new Error(`fields not allowed here: ${rejected.join(", ")}. Allowed: ${APP_FIELDS.join(", ")}`);
    }
    for (const [k, v] of Object.entries(fields)) if (typeof v === "string") assertNotSecret(k, v);
    const a = await findApp(account, application);
    await patch(account, `/applications/${a.uuid}`, fields);
    return txt(`updated ${Object.keys(fields).join(", ")} on ${a.name} — a deploy is required`);
  },
);

server.registerTool(
  "coolify_update_service",
  {
    description:
      "Changes a service: the whole compose file (as plain YAML), the container domains, the name and the description. A restart is required for the change to take effect.",
    inputSchema: {
      account,
      service: z.string().describe("uuid or name"),
      compose: z.string().optional(),
      domains: z.array(z.object({ container: z.string(), url: z.string() })).optional(),
      name: z.string().optional(),
      description: z.string().optional(),
    },
    annotations: CHANGES,
  },
  async (
    { account, service, compose, domains, name, description }: {
      account?: string;
      service: string;
      compose?: string;
      domains?: { container: string; url: string }[];
      name?: string;
      description?: string;
    },
  ) => {
    if (compose && CREDENTIALS_IN_URL.test(compose)) {
      throw new Error(
        "the compose file contains credentials in a URL: use the $SERVICE_* variables",
      );
    }
    if (compose?.includes(HIDDEN)) {
      throw new Error(
        "the compose file contains masked values: rewrite it without them, or change only what is needed from the panel",
      );
    }
    const s = await findOfKind(account, "service", service);
    await patch(account, `/services/${s.uuid}`, {
      ...(compose ? { docker_compose_raw: btoa(String.fromCodePoint(...new TextEncoder().encode(compose))) } : {}),
      ...(domains?.length ? { urls: domains.map((d) => ({ name: d.container, url: d.url })) } : {}),
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    });
    return txt(`updated ${s.name} — a restart is required`);
  },
);

server.registerTool(
  "coolify_set_env_var",
  {
    description:
      "Creates or updates an environment variable of an application, a service or a database. A redeploy or restart is required for it to take effect. Not for secrets: those are set from the Coolify panel.",
    inputSchema: {
      account,
      kind: kindArg.optional().describe("default application"),
      ref: z.string().describe("uuid or name of the resource"),
      key: z.string(),
      value: z.string(),
      literal: z.boolean().optional().describe("do not interpolate $VARIABLES inside the value"),
      multiline: z.boolean().optional(),
    },
    annotations: CHANGES,
  },
  async (
    { account, kind, ref, key, value, literal, multiline }: {
      account?: string;
      kind?: Kind;
      ref: string;
      key: string;
      value: string;
      literal?: boolean;
      multiline?: boolean;
    },
  ) => {
    assertNotSecret(key, value);
    const k = kind ?? "application";
    const r = await findOfKind(account, k, ref);
    const base = `${API_PATH[k]}/${r.uuid}/envs`;
    const current = await api(account, base) as Loose[];
    const existing = current.find((e) => e.key === key && !e.is_preview);
    const body = {
      key,
      value,
      is_preview: false,
      ...(literal !== undefined ? { is_literal: literal } : {}),
      ...(multiline !== undefined ? { is_multiline: multiline } : {}),
    };
    await api(account, base, { method: existing ? "PATCH" : "POST", body: JSON.stringify(body) });
    return txt(
      `${existing ? "updated" : "created"} ${key} on ${r.name} — a ${
        k === "application" ? "redeploy" : "restart"
      } is required`,
    );
  },
);

// ============================================================ run

server.registerTool("coolify_deploy", {
  description:
    "Starts a deployment of an application and returns the identifier to follow it with. Does not wait for completion: use coolify_deploy_status.",
  inputSchema: {
    account,
    application: z.string().describe("uuid or name of the application"),
    force: z.boolean().optional().describe("rebuild without using the cache"),
  },
  annotations: CHANGES,
}, async ({ account, application, force }: { account?: string; application: string; force?: boolean }) => {
  const a = await findApp(account, application);
  // Since Coolify 4.3 actions are POST: a GET answers 405 "endpoint has changed to a POST request".
  const r = await post(account, `/deploy?uuid=${a.uuid}${force ? "&force=true" : ""}`) as Loose;
  const d = r?.deployments?.[0];
  return txt({ application: a.name, deployment: d?.deployment_uuid, message: d?.message });
});

server.registerTool("coolify_cancel_deploy", {
  description: "Cancels a queued or running deployment.",
  inputSchema: { account, deployment: z.string() },
  annotations: CHANGES,
}, async ({ account, deployment }: { account?: string; deployment: string }) => {
  const r = await post(account, `/deployments/${deployment}/cancel`) as Loose;
  return txt({ deployment, message: r?.message ?? r });
});

server.registerTool(
  "coolify_action",
  {
    description:
      "Starts, stops or restarts an application, a service or a database, without rebuilding. To rebuild an application, use coolify_deploy.",
    inputSchema: {
      account,
      kind: kindArg,
      ref: z.string().describe("uuid or name"),
      action: z.enum(["start", "stop", "restart"]),
    },
    annotations: CHANGES,
  },
  async (
    { account, kind, ref, action }: {
      account?: string;
      kind: Kind;
      ref: string;
      action: "start" | "stop" | "restart";
    },
  ) => {
    const r = await findOfKind(account, kind, ref);
    const x = await post(account, `${API_PATH[kind]}/${r.uuid}/${action}`) as Loose;
    return txt({ resource: r.name, action, message: x?.message ?? x });
  },
);

server.registerTool(
  "coolify_scheduled_tasks",
  {
    description:
      "Manages the scheduled commands (Coolify cron) of an application or a service: list them, create one, run one now, or list its latest executions.",
    inputSchema: {
      account,
      kind: z.enum(["application", "service"]),
      ref: z.string().describe("uuid or name"),
      action: z.enum(["list", "create", "run", "executions"]),
      task: z.string().optional().describe("for run/executions: uuid or name of the task"),
      name: z.string().optional(),
      command: z.string().optional(),
      schedule: z.string().optional().describe("cron expression, e.g. 0 3 * * *, or @daily"),
      container: z.string().optional().describe("for a service: the container the task runs in"),
    },
    annotations: CHANGES,
  },
  async (
    a: {
      account?: string;
      kind: "application" | "service";
      ref: string;
      action: string;
      task?: string;
      name?: string;
      command?: string;
      schedule?: string;
      container?: string;
    },
  ) => {
    const r = await findOfKind(a.account, a.kind, a.ref);
    const base = `${API_PATH[a.kind]}/${r.uuid}/scheduled-tasks`;
    if (a.action === "list") {
      const l = await api(a.account, base) as Loose[];
      return txt(
        l.map((x) => ({
          uuid: x.uuid,
          name: x.name,
          command: maskText(String(x.command ?? "")),
          schedule: x.frequency,
          enabled: x.enabled,
          container: x.container,
        })),
      );
    }
    if (a.action === "create") {
      if (!a.name || !a.command || !a.schedule) throw new Error("name, command and schedule are required");
      if (CREDENTIALS_IN_URL.test(a.command) || maskText(a.command) !== a.command) {
        throw new Error(
          "the command contains a secret: put it in a variable from the panel",
        );
      }
      const x = await post(a.account, base, {
        name: a.name,
        command: a.command,
        frequency: a.schedule,
        ...(a.container ? { container: a.container } : {}),
        enabled: true,
      }) as Loose;
      return txt({ task: x.uuid, name: a.name, schedule: a.schedule });
    }
    if (!a.task) throw new Error("`task` is required");
    const t = await find(a.account, base, "task", a.task);
    if (a.action === "run") {
      return txt({
        task: t.name,
        message: (await post(a.account, `${base}/${t.uuid}/execute`) as Loose)?.message ?? "started",
      });
    }
    const ex = await api(a.account, `${base}/${t.uuid}/executions`) as Loose[];
    return txt(
      ex.slice(0, 10).map((e) => ({
        status: e.status,
        started: e.created_at,
        finished: e.finished_at ?? e.updated_at,
        output: maskText(String(e.message ?? "")).slice(-500),
      })),
    );
  },
);

// ============================================================ maintain

server.registerTool(
  "coolify_backup_database",
  {
    description:
      "Manages the backups of a managed database: list the scheduled ones with their latest executions, or schedule one (cron schedule, number to keep, " +
      "S3 when a storage is configured in Coolify), optionally running it immediately.",
    inputSchema: {
      account,
      database: z.string().describe("uuid or name"),
      action: z.enum(["list", "schedule"]),
      schedule: z.string().optional().describe("cron expression or @daily/@weekly; for schedule"),
      keep: z.number().int().min(1).optional().describe("number of backups to keep on the server (default 7)"),
      s3: z.string().optional().describe("uuid or name of a Coolify S3 storage"),
      now: z.boolean().optional().describe("also run a backup immediately"),
    },
    annotations: CHANGES,
  },
  async (
    a: {
      account?: string;
      database: string;
      action: "list" | "schedule";
      schedule?: string;
      keep?: number;
      s3?: string;
      now?: boolean;
    },
  ) => {
    const d = await findOfKind(a.account, "database", a.database);
    if (a.action === "list") {
      const b = await api(a.account, `/databases/${d.uuid}/backups`) as Loose[];
      const withExecutions = await Promise.all(b.map(async (x) => ({
        uuid: x.uuid,
        schedule: x.frequency,
        enabled: x.enabled,
        s3: x.save_s3,
        latest: ((await api(a.account, `/databases/${d.uuid}/backups/${x.uuid}/executions`).catch(() => [])) as Loose[])
          .slice(0, 5).map((e) => ({ status: e.status, at: e.created_at, size: e.size ?? null })),
      })));
      return txt({ database: d.name, backups: withExecutions });
    }
    if (!a.schedule) throw new Error("`schedule` is required");
    const s3 = a.s3 ? await find(a.account, "/s3-storages", "S3 storage", a.s3) : null;
    const r = await post(a.account, `/databases/${d.uuid}/backups`, {
      frequency: a.schedule,
      enabled: true,
      database_backup_retention_amount_locally: a.keep ?? 7,
      save_s3: !!s3,
      ...(s3 ? { s3_storage_uuid: s3.uuid } : {}),
      backup_now: a.now ?? false,
    }) as Loose;
    return txt({
      database: d.name,
      backup: r?.uuid ?? r,
      schedule: a.schedule,
      s3: s3?.name ?? null,
      now: a.now ?? false,
    });
  },
);

server.registerTool(
  "coolify_docker_cleanup",
  {
    description:
      "Frees disk space on the server by removing images, stopped containers and build cache that Docker no longer uses. With volumes=true it also removes volumes attached to nothing " +
      "(note: a volume of a stopped application counts as unused). Without `run` it only returns the cleanup settings and the latest cleanups.",
    inputSchema: {
      account,
      run: z.boolean().optional().describe("true to run the cleanup; otherwise only the status is returned"),
      volumes: z.boolean().optional(),
      networks: z.boolean().optional(),
    },
    annotations: { ...CHANGES, destructiveHint: true },
  },
  async (
    { account, run, volumes, networks }: { account?: string; run?: boolean; volumes?: boolean; networks?: boolean },
  ) => {
    const s = await soleServer(account);
    if (!run) {
      const [settings, latest] = await Promise.all([
        api(account, `/servers/${s.uuid}/docker-cleanup`).catch((e) => (e as Error).message),
        api(account, `/servers/${s.uuid}/docker-cleanup/executions`).catch(() => []),
      ]);
      return txt({ server: s.name, settings, latest: (latest as Loose[]).slice?.(0, 5) ?? latest });
    }
    const r = await post(account, `/servers/${s.uuid}/docker-cleanup/run`, {
      delete_unused_volumes: volumes ?? false,
      delete_unused_networks: networks ?? false,
    }) as Loose;
    return txt({ server: s.name, message: r?.message ?? r });
  },
);

await server.connect(new StdioServerTransport());

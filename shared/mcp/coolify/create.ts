// coolify — create: projects, environments, applications, services, databases.
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@4.6.5";
import { account, api, CHANGES, find, locate, type Loose, post, soleServer } from "./api.ts";
import { CREDENTIALS_IN_URL } from "../lib/mask.ts";
import { text as txt } from "../lib/service.ts";

export function register(server: McpServer) {
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
}

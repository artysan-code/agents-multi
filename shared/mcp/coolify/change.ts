// coolify — change: configuration, domains, variables.
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@4.6.5";
import {
  account,
  api,
  API_PATH,
  assertNoSecretInText,
  assertNotSecret,
  CHANGES,
  findApp,
  findOfKind,
  type Kind,
  kindArg,
  type Loose,
  patch,
  toBase64,
} from "./api.ts";
import { CREDENTIALS_IN_URL, HIDDEN } from "../lib/mask.ts";
import { text as txt } from "../lib/service.ts";

export function register(server: McpServer) {
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
        fields: z.record(z.string(), z.unknown()).describe(
          'e.g. { "domains": "https://app.example.com", "git_branch": "release" }',
        ),
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
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === "string") {
          assertNotSecret(k, v);
          assertNoSecretInText(k, v);
        }
      }
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
        ...(compose ? { docker_compose_raw: toBase64(compose) } : {}),
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
}

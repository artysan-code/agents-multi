// coolify — run: deploy, cancel, start, stop, restart, scheduled tasks.
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@4.6.5";
import {
  account,
  api,
  API_PATH,
  CHANGES,
  deploymentId,
  find,
  findApp,
  findOfKind,
  type Kind,
  kindArg,
  type Loose,
  post,
} from "./api.ts";
import { CREDENTIALS_IN_URL, maskText } from "../lib/mask.ts";
import { text as txt } from "../lib/service.ts";

export function register(server: McpServer) {
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
    inputSchema: { account, deployment: deploymentId },
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
}

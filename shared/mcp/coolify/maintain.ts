// coolify — maintain: database backups, Docker cleanup.
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@4.6.5";
import { account, api, CHANGES, find, findOfKind, type Loose, post, soleServer, unavailable } from "./api.ts";
import { text as txt } from "../lib/service.ts";

export function register(server: McpServer) {
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
          latest: await api(a.account, `/databases/${d.uuid}/backups/${x.uuid}/executions`).then(
            (r) =>
              (r as Loose[]).slice(0, 5).map((e) => ({ status: e.status, at: e.created_at, size: e.size ?? null })),
            unavailable,
          ),
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
          api(account, `/servers/${s.uuid}/docker-cleanup/executions`).catch(unavailable),
        ]);
        return txt({ server: s.name, settings, latest: Array.isArray(latest) ? latest.slice(0, 5) : latest });
      }
      const r = await post(account, `/servers/${s.uuid}/docker-cleanup/run`, {
        delete_unused_volumes: volumes ?? false,
        delete_unused_networks: networks ?? false,
      }) as Loose;
      return txt({ server: s.name, message: r?.message ?? r });
    },
  );
}

// schedule.ts — in app mode the console's backend runs the jobs the systemd timers run in dev mode
// (systemd/user/*.timer), so nothing depends on systemd: the app starts at login in the tray, and its
// backend runs them while it is up. Each job is a command of the running code, as its unit's was; a
// job still running when its time comes again is not started twice, and one that runs too long is
// stopped. Its output goes to the backend's (the app's backend.log).

import { RUNTIME } from "../lib/paths.ts";

export interface Job {
  name: string;
  cmd: string[];
  /** ms after the start of the first run, or "clock": on the clock, every `every` (OnCalendar) */
  first: number | "clock";
  every: number;
  /** stopped after this many ms */
  timeout: number;
}

const MIN = 60_000;

/** Pure: the jobs for this machine, as install enables their timers in dev mode. */
export function jobsFor(f: { repo: string; graphical: boolean; brain: boolean; syncthing: boolean }): Job[] {
  const agents = `${f.repo}/bin/agents`;
  const jobs: Job[] = [];
  // task briefs and reminders are desktop notifications: claude-tasks.timer, every 5 min on the clock
  if (f.graphical) {
    jobs.push({ name: "tasks", cmd: [agents, "tasks", "remind"], first: "clock", every: 5 * MIN, timeout: 2 * MIN });
  }
  // a copy of the brain when it changed: claude-brain-backup.timer
  if (f.brain) {
    jobs.push({
      name: "brain-backup",
      cmd: [agents, "brain-backup"],
      first: 10 * MIN,
      every: 30 * MIN,
      timeout: 10 * MIN,
    });
  }
  // Claude Code and Desktop updates, then the doctor as a watchdog: claude-update-check.timer
  if (f.graphical) {
    jobs.push({
      name: "update-check",
      cmd: ["sh", "-c", '"$0/bin/claude-update" --auto; "$0/bin/agents" doctor --notify', f.repo],
      first: 10 * MIN,
      every: 240 * MIN,
      timeout: 20 * MIN,
    });
  }
  // git repositories inside Syncthing folders kept out of it: stignore-gen.timer
  if (f.syncthing) {
    jobs.push({
      name: "stignore-gen",
      cmd: [`${f.repo}/shared/tools/stignore-gen/stignore-gen.ts`, "--apply", "--quiet"],
      first: 2 * MIN,
      every: 15 * MIN,
      timeout: 5 * MIN,
    });
  }
  return jobs;
}

/** Pure: ms until a job's next run, at `now`; `ran` whether it has run since the start. */
export function nextDelay(job: Job, now: number, ran: boolean): number {
  if (job.first === "clock") return job.every - (now % job.every) || job.every;
  return ran ? job.every : job.first;
}

/** Pure: the PATH a job gets: the backend's, then the runtime's bin (the package's Deno, which the
 *  scripts with a `deno` shebang find there when no other one is on PATH). */
export function jobPath(path: string | undefined, runtime = RUNTIME): string {
  const dirs = (path ?? "").split(":").filter(Boolean);
  return [...dirs, ...(dirs.includes(`${runtime}/bin`) ? [] : [`${runtime}/bin`])].join(":");
}

/** Starts the jobs; the returned function stops scheduling them. */
export function startSchedule(jobs: Job[], log: (s: string) => void = console.log): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;
  const busy = new Set<string>();
  const run = async (job: Job) => {
    if (busy.has(job.name)) return log(`schedule: ${job.name} is still running, skipped`);
    busy.add(job.name);
    try {
      const r = await new Deno.Command(job.cmd[0], {
        args: job.cmd.slice(1),
        env: { PATH: jobPath(Deno.env.get("PATH")) },
        stdin: "null",
        stdout: "inherit",
        stderr: "inherit",
        signal: AbortSignal.timeout(job.timeout),
      }).output();
      if (!r.success) log(`schedule: ${job.name} exited with ${r.code}${r.signal ? ` (${r.signal})` : ""}`);
    } catch (e) {
      log(`schedule: ${job.name}: ${(e as Error).message}`);
    } finally {
      busy.delete(job.name);
    }
  };
  const plan = (job: Job, ran: boolean) => {
    if (stopped) return;
    timers.set(
      job.name,
      setTimeout(() => {
        void run(job);
        plan(job, true);
      }, nextDelay(job, Date.now(), ran)),
    );
  };
  for (const job of jobs) plan(job, false);
  if (jobs.length) log(`schedule: ${jobs.map((j) => j.name).join(", ")}`);
  return () => {
    stopped = true;
    for (const t of timers.values()) clearTimeout(t);
  };
}

// The Node names the build configs (vite.config.ts, vite.web.config.ts) use: the interface itself runs in a browser,
// so the Node types are not a dependency.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function renameSync(from: string, to: string): void;
}
declare const process: { env: Record<string, string | undefined> };

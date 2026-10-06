// guard.ts — what the service refuses before a request reaches a handler: a body larger than its
// path allows. The handlers read bodies with req.text() and req.json(), which would otherwise take
// whatever arrives; every request is capped here, once, in front of them.

/** A body over the limit: the handler's read fails with it, and the service answers 413. */
export class TooLarge extends Error {
  constructor(readonly limit: number) {
    super(`request body over ${limit} bytes`);
  }
}

const KB = 1024;
/** Pure: the most a request to this path may send. The sign-in and OAuth forms are small; the MCP
 *  calls, the task files and the board's forms carry a page or a task's notes. */
export function bodyLimit(path: string): number {
  if (
    path === "/register" || path === "/token" || path === "/authorize" || path === "/invite" ||
    path.startsWith("/account")
  ) return 64 * KB;
  return 1024 * KB;
}

/** The request with its body capped at `limit` bytes: a declared length over it fails at once, a
 *  stream that grows past it fails when the handler reads that far. */
export function capped(req: Request, limit: number): Request {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) throw new TooLarge(limit);
  if (!req.body) return req;
  let seen = 0;
  const body = req.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        seen += chunk.byteLength;
        if (seen > limit) throw new TooLarge(limit);
        out.enqueue(chunk);
      },
    }),
  );
  return new Request(req.url, { method: req.method, headers: req.headers, body });
}

/** Pure: whether an error, or what it wraps, is a body over the limit. */
export function isTooLarge(e: unknown): boolean {
  for (let x = e; x instanceof Error; x = x.cause) if (x instanceof TooLarge) return true;
  return false;
}

// guard.ts — what the service refuses before a request reaches a handler, and the pieces that keep
// one caller from taking it all: a body larger than its path allows (the handlers read bodies with
// req.text() and req.json(), which would otherwise take whatever arrives: every request is capped
// here, once, in front of them), the client's address, a rate limit per address, and a gate that
// lets a few expensive jobs run at once.

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

/** Pure: the address a request came from. Behind a proxy the connection is the proxy's, so the
 *  deployment names the header that carries the client (BRAIN_CLIENT_IP_HEADER: cf-connecting-ip
 *  behind Cloudflare); in a list the last entry counts, the one the nearest proxy wrote. Without the
 *  header, the connection's own address. Only trust a header a proxy in front always sets: a client
 *  reaching the service directly can write any value in it. */
export function clientIp(headers: Headers, remote: string, header?: string): string {
  const v = header ? headers.get(header) : null;
  return v?.split(",").map((s) => s.trim()).filter(Boolean).at(-1) ?? remote;
}

/** Requests per key (an address) as a token bucket: `burst` at once, then one every `everyMs`.
 *  In memory: a restart forgets, which costs an attacker nothing they could not do anyway. */
export class Buckets {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private burst: number, private everyMs: number) {}

  /** 0 when the request may go, otherwise how many seconds until it may. */
  take(key: string, now = Date.now()): number {
    if (this.b.size > 10_000) this.sweep(now);
    const cur = this.b.get(key) ?? { tokens: this.burst, at: now };
    const tokens = Math.min(this.burst, cur.tokens + (now - cur.at) / this.everyMs);
    if (tokens < 1) {
      this.b.set(key, { tokens, at: now });
      return Math.ceil(((1 - tokens) * this.everyMs) / 1000);
    }
    this.b.set(key, { tokens: tokens - 1, at: now });
    return 0;
  }

  /** The keys that have filled up again are the same as never seen: dropped. */
  private sweep(now: number) {
    for (const [k, v] of this.b) if (v.tokens + (now - v.at) / this.everyMs >= this.burst) this.b.delete(k);
  }
}

/** At most `size` jobs at once, at most `queue` waiting; past that `run` refuses at once with null,
 *  so a flood waits in a short line instead of piling up work. */
export class Gate {
  private running = 0;
  private waiting: (() => void)[] = [];
  constructor(private size: number, private queue: number) {}

  async run<T>(job: () => Promise<T>): Promise<T | null> {
    if (this.running >= this.size) {
      if (this.waiting.length >= this.queue) return null;
      await new Promise<void>((go) => this.waiting.push(go));
    } else this.running++;
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // the slot passes straight to the next in line
      else this.running--;
    }
  }
}

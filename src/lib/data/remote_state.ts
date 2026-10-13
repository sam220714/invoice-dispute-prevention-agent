import { readStateTree, writeStateTree } from "./load";

/**
 * Makes state/ survive on a serverless host.
 *
 * Every screen and action reads and writes state/ synchronously. On Vercel each instance has its own
 * disk, so a request that lands on another instance sees nothing the previous one wrote: a pasted
 * analysis vanishes before "Accept" is pressed. This keeps that code as it is and moves the directory
 * through a shared Redis around it: hydrate() pulls the latest copy before a request reads state,
 * flush() pushes it back after a request has changed it. Redis is the source of truth, the disk is a cache.
 *
 * With no Redis configured (local dev, tests) both are no-ops and state/ is simply the files.
 * Per-run context snapshots (runs/) are write-only debugging output and stay local. The file access itself
 * lives in load.ts, the one module allowed to touch the disk.
 */
// One copy per environment. Production, preview deployments and a laptop that happens to have the same
// Redis credentials in .env.local must not overwrite each other's demo.
const KEY = `dispute-agent:state:${process.env.VERCEL_ENV ?? "local"}`;

const endpoint = () => {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
};

export const remoteStateConfigured = (): boolean => endpoint() !== null;

async function command(...args: string[]): Promise<unknown> {
  const e = endpoint();
  if (!e) throw new Error("no Redis configured");
  const res = await fetch(e.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${e.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
  if (!res.ok || !body || body.error) throw new Error(`redis ${args[0]} failed: ${body?.error ?? res.status}`);
  return body.result ?? null;
}

type Files = Record<string, string>;

let inflight: Promise<void> | null = null;

async function pull(): Promise<void> {
  const raw = await command("GET", KEY);
  if (typeof raw !== "string") return; // nothing stored yet: keep whatever the disk has (a fresh seed)
  writeStateTree((JSON.parse(raw) as { files: Files }).files);
}

/**
 * Bring this instance up to date. Call first thing in anything that reads state. Concurrent callers (a layout and
 * its page render together) share one fetch. If Redis cannot be reached the request carries on with the disk
 * copy rather than failing the page, and says so in the log.
 */
export function hydrate(): Promise<void> {
  if (!endpoint()) return Promise.resolve();
  inflight ??= pull()
    .catch((err) => console.error("state: could not load from Redis, using the local copy.", err))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Store this instance's state. Call after anything that changed it. A failure is thrown: a silent loss is worse. */
export async function flush(): Promise<void> {
  if (!endpoint()) return;
  await command("SET", KEY, JSON.stringify({ files: readStateTree(), at: new Date().toISOString() }));
}

/** Run a state-changing action against the shared copy: pull first, push after, even when it redirects or throws. */
export async function persisted<T>(fn: () => Promise<T>): Promise<T> {
  await hydrate();
  try {
    return await fn();
  } finally {
    await flush();
  }
}

/**
 * Best-effort OS process start-time lookup, used to defeat PID reuse when
 * deciding whether a recorded PID still names the *same* process that wrote a
 * file referencing it.
 *
 * `process.kill(pid, 0)` only proves *some* process owns the PID right now.
 * PIDs recycle — quickly on Windows — so an orphaned PID reference can point
 * at an unrelated live process and read as "still running" forever. Comparing
 * the OS-reported start time against a recorded timestamp distinguishes the
 * real process from a recycled PID.
 *
 * NON-BLOCKING BY DESIGN. OS metadata reads and subprocess queries are
 * asynchronous, so slow lookups do not stall the extension-host event loop:
 *
 *   - `getProcessStartTimes(pids)` is synchronous and returns ONLY what is
 *     already cached — it never spawns. Misses trigger a fire-and-forget async
 *     refresh so the next call sees fresh values. Callers on hot paths (the
 *     live-session poll) get eventual consistency within one tick with zero
 *     event-loop stall.
 *   - `getProcessStartTimesAsync(pids)` awaits a refresh of any stale PIDs and
 *     is for callers that can await a definitive answer.
 *
 * Both return unix-epoch milliseconds per PID; a PID absent from the result
 * means the start time is not (yet) known. Callers MUST treat "unknown" as
 * "cannot disambiguate" and fall back to the plain liveness check rather than
 * dropping a possibly-live entry.
 */
import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

/**
 * Memo TTL. A live process's start time is immutable, so re-querying every
 * tick would be waste; the TTL still bounds how long a freshly-reused PID can
 * masquerade before we re-check — at most one TTL window.
 */
const TTL_MS = 5000;

/** Max time to wait on a subprocess query before giving up (→ unknown). */
const QUERY_TIMEOUT_MS = 4000;

interface Entry {
  /** unix ms, or null when the query positively failed for this PID. */
  startMs: number | null;
  /** Date.now() when this entry was recorded. */
  at: number;
}

const cache = new Map<number, Entry>();
/** PIDs with an async refresh in flight — dedupes concurrent queries. */
const inflight = new Map<number, Promise<void>>();

function isFresh(entry: Entry | undefined, now: number): boolean {
  return entry !== undefined && now - entry.at < TTL_MS;
}

/**
 * Synchronous, non-blocking. Returns cached start times only; schedules an
 * async refresh for anything missing or stale so a subsequent call sees it.
 */
export function getProcessStartTimes(pids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  const now = Date.now();
  const stale: number[] = [];

  for (const pid of pids) {
    const e = cache.get(pid);
    if (isFresh(e, now)) {
      if (e!.startMs !== null) out.set(pid, e!.startMs);
    } else {
      stale.push(pid);
    }
  }

  if (stale.length > 0) void refresh(stale);
  return out;
}

/**
 * Awaits a refresh of any missing/stale PIDs, then returns cached start times.
 * Use from callers already on an async path that want a definitive answer.
 */
export async function getProcessStartTimesAsync(pids: number[]): Promise<Map<number, number>> {
  const now = Date.now();
  const stale = pids.filter((pid) => !isFresh(cache.get(pid), now));
  if (stale.length > 0) await refresh(stale);

  const out = new Map<number, number>();
  for (const pid of pids) {
    const e = cache.get(pid);
    if (e && e.startMs !== null) out.set(pid, e.startMs);
  }
  return out;
}

/** Query the OS for the given PIDs and fold the results into the cache. */
async function refresh(pids: number[]): Promise<void> {
  const unique = [...new Set(pids)];
  const waiting = [...new Set(unique.map((pid) => inflight.get(pid)).filter((pending): pending is Promise<void> => pending !== undefined))];
  const todo = unique.filter((pid) => !inflight.has(pid));
  if (todo.length) {
    const pending = (async () => {
      try {
        const fresh = await queryStartTimes(todo);
        const now = Date.now();
        for (const pid of todo) cache.set(pid, { startMs: fresh.get(pid) ?? null, at: now });
        pruneCache(now);
      } finally {
        for (const pid of todo) inflight.delete(pid);
      }
    })();
    for (const pid of todo) inflight.set(pid, pending);
    waiting.push(pending);
  }
  await Promise.all(waiting);
}

/** Drop cache entries older than one TTL so it cannot grow without bound. */
function pruneCache(now: number): void {
  for (const [pid, e] of cache) {
    if (now - e.at >= TTL_MS) cache.delete(pid);
  }
}

function queryStartTimes(pids: number[]): Promise<Map<number, number>> {
  switch (process.platform) {
    case "linux":
      return queryLinux(pids);
    case "darwin":
      return queryDarwin(pids);
    case "win32":
      return queryWindows(pids);
    default:
      return Promise.resolve(new Map());
  }
}

interface LinuxClock {
  bootMs: number;
  ticksPerSecond: number;
}
let linuxClockCache: { clock: LinuxClock | null; at: number } | undefined;
let linuxClockQuery: Promise<LinuxClock | null> | undefined;

/** Boot time and USER_HZ are constant for this process; failed discovery can retry. */
function getLinuxClock(): Promise<LinuxClock | null> {
  if (linuxClockCache && (linuxClockCache.clock !== null || Date.now() - linuxClockCache.at < TTL_MS)) {
    return Promise.resolve(linuxClockCache.clock);
  }
  if (!linuxClockQuery) {
    linuxClockQuery = queryLinuxClock().then((clock) => {
      linuxClockCache = { clock, at: Date.now() };
      linuxClockQuery = undefined;
      return clock;
    });
  }
  return linuxClockQuery;
}

async function queryLinuxClock(): Promise<LinuxClock | null> {
  try {
    const [procStat, { stdout }] = await Promise.all([
      fs.promises.readFile("/proc/stat", "utf-8"),
      execFileP("getconf", ["CLK_TCK"], { encoding: "utf-8", timeout: QUERY_TIMEOUT_MS }),
    ]);
    const boot = procStat.match(/^btime\s+(\d+)\s*$/m);
    if (!boot || !/^\s*\d+\s*$/.test(stdout)) return null;
    const bootSeconds = Number(boot[1]);
    const ticksPerSecond = Number(stdout.trim());
    const bootMs = bootSeconds * 1000;
    if (!Number.isSafeInteger(bootMs) || !Number.isSafeInteger(ticksPerSecond) || ticksPerSecond <= 0) return null;
    return { bootMs, ticksPerSecond };
  } catch {
    // Missing /proc metadata or getconf cannot be replaced with guessed clock units.
    return null;
  }
}

/** Field 22 is immutable process start ticks; directory mtimes can change on inode eviction. */
function linuxProcessStart(raw: string, pid: number, clock: LinuxClock): number | undefined {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 1 || close <= open || Number(raw.slice(0, open).trim()) !== pid) return undefined;
  // Fields after the final ')' begin at state (field 3); names may contain parentheses/spaces.
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const value = fields[19];
  if (!value || !/^\d+$/.test(value)) return undefined;
  const ticks = Number(value);
  if (!Number.isSafeInteger(ticks)) return undefined;
  const startMs = clock.bootMs + (ticks / clock.ticksPerSecond) * 1000;
  return Number.isSafeInteger(Math.trunc(startMs)) ? startMs : undefined;
}

async function queryLinux(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const clock = await getLinuxClock();
  if (!clock) return out;
  await Promise.all(pids.map(async (pid) => {
    try {
      const raw = await fs.promises.readFile(`/proc/${pid}/stat`, "utf-8");
      const start = linuxProcessStart(raw, pid, clock);
      if (start !== undefined) out.set(pid, start);
    } catch {
      // Process gone or /proc unreadable — leave unknown.
    }
  }));
  return out;
}

/**
 * macOS: no `/proc`, so shell out to `ps`. `lstart` is a full local-time date
 * string ("Wed Jul  1 11:39:30 2026") that `Date.parse` reads as local time,
 * yielding the correct UTC ms. One call covers every PID.
 */
async function queryDarwin(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const { stdout } = await execFileP("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
      encoding: "utf-8",
      timeout: QUERY_TIMEOUT_MS,
    });
    for (const line of stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ms = Date.parse(m[2]);
      if (Number.isFinite(pid) && Number.isFinite(ms)) out.set(pid, ms);
    }
  } catch {
    // ps missing or timed out — leave all unknown.
  }
  return out;
}

/**
 * Windows: query the CIM process table. `Win32_Process.CreationDate` is the
 * exact fork time; casting through `[DateTimeOffset]` yields UTC unix ms
 * directly. CIM is used over `Get-Process().StartTime` because the latter
 * throws "Access denied" for processes owned by other users, which would make
 * unrelated live PIDs look unknown (and thus be wrongly trusted).
 */
async function queryWindows(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const filter = pids.map((p) => `ProcessId=${p}`).join(" or ");
  const script =
    `Get-CimInstance Win32_Process -Filter '${filter}' | ` +
    "ForEach-Object { $_.ProcessId.ToString() + ' ' + " +
    "([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  try {
    const { stdout } = await execFileP(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf-8", timeout: QUERY_TIMEOUT_MS, windowsHide: true },
    );
    for (const line of stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      out.set(Number(m[1]), Number(m[2]));
    }
  } catch {
    // powershell unavailable or timed out — leave all unknown.
  }
  return out;
}

/** Test-only: reset the memo between cases. */
export function _clearProcStartCache(): void {
  cache.clear();
  inflight.clear();
  linuxClockCache = undefined;
  linuxClockQuery = undefined;
}

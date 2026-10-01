import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG_LOCK,
  CREDENTIAL_LOCKS,
  describeLockFailure,
  type LockSpec,
  withLocks,
} from "../claudeLocks";

/**
 * These run against the real filesystem in a temp directory. The whole point
 * of the module is `mkdir` atomicity and mtime ageing, and a mocked fs would
 * test the mock rather than the protocol.
 */
let dir: string;
const lock = (name: string, staleMs = 60_000): LockSpec => ({
  dir: path.join(dir, name),
  staleMs,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-locks-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("withLocks", () => {
  it("runs the work and releases the lock afterwards", () => {
    const a = lock("a.lock");
    const result = withLocks([a], () => {
      expect(fs.existsSync(a.dir)).toBe(true);
      return "done";
    });

    expect(result).toEqual({ ok: true, value: "done" });
    expect(fs.existsSync(a.dir)).toBe(false);
  });

  it("acknowledges multiple locks without losing worker wakeups", () => {
    const specs = [lock("a.lock"), lock("b.lock"), lock("c.lock")];
    for (let iteration = 0; iteration < 8; iteration++) {
      expect(withLocks(specs, () => iteration)).toEqual({ ok: true, value: iteration });
      for (const spec of specs) expect(fs.existsSync(spec.dir)).toBe(false);
    }
  }, 20_000);

  it("releases the lock when the work throws, and lets the error out", () => {
    const a = lock("a.lock");
    expect(() =>
      withLocks([a], () => {
        throw new Error("write failed");
      }),
    ).toThrow("write failed");
    expect(fs.existsSync(a.dir)).toBe(false);
  });

  it("releases every lock even when one cannot be removed", () => {
    // A lock directory that has gained a file cannot be rmdir'd. Releasing
    // must carry on regardless: giving up on the first failure would strand
    // the other lock until its stale window expired, blocking Claude Code.
    const a = lock("a.lock");
    const b = lock("b.lock");

    const result = withLocks([a, b], () => {
      fs.writeFileSync(path.join(a.dir, "stray"), "x");
      return "ok";
    });

    expect(result).toEqual({ ok: true, value: "ok" });
    expect(fs.existsSync(b.dir)).toBe(false);
  });

  it("does not run the work when a lock is held by someone alive", () => {
    const a = lock("a.lock");
    fs.mkdirSync(a.dir); // a live holder, mtime = now

    const work = vi.fn();
    const result = withLocks([a], work);

    expect(work).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("busy");
    // Someone else's lock must survive our failed attempt.
    expect(fs.existsSync(a.dir)).toBe(true);
  });

  it("reclaims a lock whose holder died", () => {
    const a = lock("a.lock", 50);
    fs.mkdirSync(a.dir);
    // Age it past its stale window: the holder crashed without releasing.
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(a.dir, old, old);

    const result = withLocks([a], () => "recovered");

    expect(result).toEqual({ ok: true, value: "recovered" });
    expect(fs.existsSync(a.dir)).toBe(false);
  });

  it("treats a lock that is merely old-but-live as held", () => {
    // Just inside the window — the holder is slow, not dead.
    const a = lock("a.lock", 60_000);
    fs.mkdirSync(a.dir);
    const recent = new Date(Date.now() - 1_000);
    fs.utimesSync(a.dir, recent, recent);

    const result = withLocks([a], () => "should not run");

    expect(result.ok).toBe(false);
  });

  it("releases locks it already holds when a later one cannot be taken", () => {
    const a = lock("a.lock");
    const b = lock("b.lock");
    fs.mkdirSync(b.dir); // second lock is held by someone else

    const result = withLocks([a, b], () => "nope");

    expect(result.ok).toBe(false);
    // The first lock must not be left behind for the stale timer to reap.
    expect(fs.existsSync(a.dir)).toBe(false);
    expect(fs.existsSync(b.dir)).toBe(true);
  });

  it("reports an unavailable lock separately from a busy one", () => {
    // A path whose parent does not exist cannot be created at all — that is a
    // different problem from contention and must not read as "try again".
    const broken: LockSpec = { dir: path.join(dir, "missing", "deep", "x.lock"), staleMs: 1_000 };

    const result = withLocks([broken], () => "nope");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe("unavailable");
      expect(describeLockFailure(result.failure)).toContain("Could not coordinate");
    }
  });

  it("keeps a blocking writer fresh against a separate process", async () => {
    const a = lock("a.lock", 1_200);
    const ready = path.join(dir, "peer-ready");
    const report = path.join(dir, "peer-report.json");
    let finished: Promise<number | null> | undefined;
    const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const result = withLocks([a], () => {
      const peer = spawn(
        process.execPath,
        [
          "-e",
          `
        const fs = require("fs");
        const [lock, ready, report] = process.argv.slice(1);
        fs.writeFileSync(ready, "ready");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800);
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        const stale = age >= 1200;
        if (stale) { fs.rmdirSync(lock); fs.mkdirSync(lock); }
        fs.writeFileSync(report, JSON.stringify({ stale, age }));
      `,
          a.dir,
          ready,
          report,
        ],
        { stdio: "ignore", windowsHide: true },
      );
      finished = new Promise((resolve, reject) => {
        peer.once("exit", resolve);
        peer.once("error", reject);
      });
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(ready) && Date.now() < deadline) pause(20);
      expect(fs.existsSync(ready)).toBe(true);
      pause(3_000);
      return "protected";
    });
    expect(await finished).toBe(0);
    expect(JSON.parse(fs.readFileSync(report, "utf8")).stale).toBe(false);
    expect(result).toEqual({ ok: true, value: "protected" });
    expect(fs.existsSync(a.dir)).toBe(false);
  }, 20_000);

  it("does not remove a replacement lock owned by another writer", () => {
    const a = lock("a.lock");
    const result = withLocks([a], () => {
      fs.renameSync(a.dir, path.join(dir, "old-generation.lock"));
      fs.mkdirSync(a.dir);
      return "replaced";
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("unavailable");
    expect(fs.existsSync(a.dir)).toBe(true);
  });

  it("serialises two writers: the second cannot enter while the first holds", () => {
    const a = lock("a.lock");
    let inner: ReturnType<typeof withLocks<string>> | null = null;

    withLocks([a], () => {
      // Simulates Claude Code refreshing while we try to swap.
      inner = withLocks([a], () => "interleaved");
      return "outer";
    });

    expect(inner).not.toBeNull();
    expect(inner?.ok).toBe(false);
  });
});

describe("lock specs", () => {
  it("takes the primary credential lock before the legacy one", () => {
    expect(CREDENTIAL_LOCKS.map((l) => path.basename(l.dir))).toEqual([
      ".oauth_refresh.lock",
      ".claude.lock",
    ]);
  });

  it("gives the credential locks a longer stale window than the config lock", () => {
    // The credential path holds its lock across a network refresh; the config
    // write is local. Copying one window onto both would either reclaim a live
    // refresh lock early or leave a dead config lock in place for a minute.
    for (const l of CREDENTIAL_LOCKS) expect(l.staleMs).toBe(60_000);
    expect(CONFIG_LOCK.staleMs).toBe(10_000);
  });

  it("points at the paths Claude Code actually uses", () => {
    const home = os.homedir();
    expect(CREDENTIAL_LOCKS[0].dir).toBe(path.join(home, ".claude", ".oauth_refresh.lock"));
    expect(CREDENTIAL_LOCKS[1].dir).toBe(path.join(home, ".claude.lock"));
    expect(CONFIG_LOCK.dir).toBe(path.join(home, ".claude.json.lock"));
  });
});

describe("describeLockFailure", () => {
  it("tells the user to retry when the lock is merely busy", () => {
    expect(describeLockFailure({ reason: "busy", lock: "/x" })).toContain("Try again");
  });
});

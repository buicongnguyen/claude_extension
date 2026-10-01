/** Coordinate live writes with Claude's directory locks, without blocking their heartbeat. */
import * as fs from "fs";
import * as path from "path";
import { CLAUDE_DIR } from "../../core/config";
import {
  createLockHeartbeat,
  lockIdentity,
  type LockHeartbeat,
  type OwnedLock,
} from "./lockHeartbeat";

export interface LockSpec {
  readonly dir: string;
  readonly staleMs: number;
}

export const CREDENTIAL_LOCKS: readonly LockSpec[] = [
  { dir: path.join(CLAUDE_DIR, ".oauth_refresh.lock"), staleMs: 60_000 },
  { dir: `${CLAUDE_DIR}.lock`, staleMs: 60_000 },
];
export const CONFIG_LOCK: LockSpec = { dir: `${CLAUDE_DIR}.json.lock`, staleMs: 10_000 };
const ACQUIRE_TIMEOUT_MS = 3_000;
const RETRY_INTERVAL_MS = 120;
export type LockFailure =
  | { reason: "busy"; lock: string }
  | { reason: "unavailable"; lock: string; detail: string };

type AcquireResult =
  | { kind: "taken"; owned: OwnedLock }
  | { kind: "held" }
  | { kind: "error"; detail: string };
function tryAcquire(spec: LockSpec): AcquireResult {
  const take = (): AcquireResult => {
    fs.mkdirSync(spec.dir, { mode: 0o700 });
    const identity = lockIdentity(spec.dir);
    if (!identity) return { kind: "error", detail: "Could not verify the new credential lock." };
    return { kind: "taken", owned: { ...spec, identity } };
  };
  try {
    return take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      return { kind: "error", detail: (error as Error).message };
  }
  const identity = lockIdentity(spec.dir);
  if (!identity) return { kind: "held" };
  try {
    if (Date.now() - fs.statSync(spec.dir).mtimeMs < spec.staleMs) return { kind: "held" };
    // Recheck both generation and freshness before reclaiming a dead holder.
    if (
      lockIdentity(spec.dir) !== identity ||
      Date.now() - fs.statSync(spec.dir).mtimeMs < spec.staleMs
    )
      return { kind: "held" };
    fs.rmdirSync(spec.dir);
    return take();
  } catch {
    return { kind: "held" };
  }
}

/** The callback is synchronous; a separate worker keeps all held locks fresh. */
export function withLocks<T>(
  specs: readonly LockSpec[],
  work: () => T,
): { ok: true; value: T } | { ok: false; failure: LockFailure } {
  const held: OwnedLock[] = [];
  let heartbeat: LockHeartbeat | undefined;
  const releaseAll = (): boolean => {
    // Wait for heartbeat shutdown before releasing; an unconfirmed stop leaves
    // the locks intact for normal stale recovery rather than racing a late touch.
    const stopped = heartbeat?.stop() ?? true;
    heartbeat = undefined;
    for (const lock of held.splice(0).reverse()) {
      if (!stopped || lockIdentity(lock.dir) !== lock.identity) continue;
      try {
        fs.rmdirSync(lock.dir);
      } catch {
        /* Never delete another holder or a nonempty directory. */
      }
    }
    return stopped;
  };
  const unavailable = (lock: string, detail: string): { ok: false; failure: LockFailure } => {
    releaseAll();
    return { ok: false, failure: { reason: "unavailable", lock, detail } };
  };
  for (const spec of specs) {
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
    let owned: OwnedLock | undefined;
    for (;;) {
      const result = tryAcquire(spec);
      if (result.kind === "taken") {
        owned = result.owned;
        break;
      }
      if (result.kind === "error") return unavailable(spec.dir, result.detail);
      if (Date.now() >= deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_INTERVAL_MS);
    }
    if (!owned) {
      releaseAll();
      return { ok: false, failure: { reason: "busy", lock: spec.dir } };
    }
    held.push(owned);
    try {
      heartbeat ??= createLockHeartbeat();
      if (!heartbeat.add(owned))
        return unavailable(
          spec.dir,
          "The credential lock heartbeat could not be started. Retry the operation.",
        );
    } catch {
      return unavailable(
        spec.dir,
        "The credential lock heartbeat is unavailable. Retry the operation.",
      );
    }
  }
  try {
    const value = work();
    const healthy =
      (!heartbeat || heartbeat.healthy()) &&
      held.every((lock) => lockIdentity(lock.dir) === lock.identity);
    const lock = held[0]?.dir ?? "";
    const stopped = releaseAll();
    if (!healthy || !stopped)
      return {
        ok: false,
        failure: {
          reason: "unavailable",
          lock,
          detail: "Credential lock ownership was lost. Verify the active account before retrying.",
        },
      };
    return { ok: true, value };
  } catch (error) {
    releaseAll();
    throw error;
  }
}

export function describeLockFailure(failure: LockFailure): string {
  return failure.reason === "busy"
    ? "Claude Code is refreshing its credentials right now. Try again in a moment."
    : `Could not coordinate with Claude Code (${failure.detail}).`;
}

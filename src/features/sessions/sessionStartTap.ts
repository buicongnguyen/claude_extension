#!/usr/bin/env node
/**
 * SessionStart hook executed by Claude CLI on every session boot. Reads
 * the hook payload from stdin (`{ session_id, transcript_path, cwd, … }`),
 * resolves the Claude process and its host-shell ancestors, and appends one
 * entry to the active-sessions registry the extension watches.
 *
 * The extension matches the terminal processId against ancestors above Claude
 * and separately checks Claude liveness to show View for the session running in
 * that terminal. Stale entries are pruned by the host (no need for the
 * hook to clean up — CLI process exit doesn't get a SessionEnd we can
 * trust on every crash path).
 *
 * Exits 0 with no stdout/stderr — Claude CLI continues unaffected.
 * Failure modes (locked file, no perms, malformed payload) swallow
 * silently: the hook MUST NOT block or noisily fail, or it would break
 * every CLI boot.
 */
import * as fs from "fs";
import { writeFileAtomic } from "../../core/atomicWrite";
import { findClaudeProcess, getProcessAncestors } from "./processTree";
import { CLAUDE_MANAGER_DIR, SESSION_ACTIVE_FILE } from "../../core/config";

interface ActiveEntry {
  sessionId: string;
  ppid: number;
  terminalPids: number[];
  claudePid: number;
  claudeStartedAt?: number;
  cwd: string;
  transcriptPath: string;
  ts: number;
}

interface HookPayload {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
}

/** Read JSON payload from stdin. Returns null on parse failure. */
function readStdin(): Promise<HookPayload | null> {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      if (!raw.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    process.stdin.on("error", () => resolve(null));
  });
}

/** Coerce unknown into a non-empty string, or empty when absent. */
function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Keep live Claude entries, regardless of age, then append the new entry.
 * A long-running client remains linked until it exits; the host also checks PID reuse.
 */
function readRegistry(file: string): ActiveEntry[] {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is ActiveEntry => {
      if (!e || typeof e !== "object") return false;
      const id = (e as ActiveEntry).sessionId;
      const claudePid = (e as ActiveEntry).claudePid;
      const ts = (e as ActiveEntry).ts;
      if (typeof id !== "string" || !Number.isSafeInteger(claudePid) || claudePid <= 0 || typeof ts !== "number") {
        return false;
      }
      try {
        process.kill(claudePid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    });
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const payload = await readStdin();
  if (!payload) return;

  const sessionId = s(payload.session_id);
  if (!sessionId) return;

  const chain = findClaudeProcess(await getProcessAncestors(process.ppid));
  if (!chain) return;
  const dir = CLAUDE_MANAGER_DIR;
  const file = SESSION_ACTIVE_FILE;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }

  const entries = readRegistry(file);
  const withoutSession = entries.filter((e) => e.sessionId !== sessionId);
  const entry: ActiveEntry = {
    sessionId,
    ppid: chain.terminalPids[0],
    terminalPids: chain.terminalPids,
    claudePid: chain.claudePid,
    claudeStartedAt: chain.claudeStartedAt,
    cwd: s(payload.cwd) || process.cwd(),
    transcriptPath: s(payload.transcript_path),
    ts: Date.now(),
  };
  withoutSession.push(entry);

  try {
    writeFileAtomic(file, JSON.stringify(withoutSession));
  } catch {
    /* swallow — never block CLI boot */
  }
}

void main();

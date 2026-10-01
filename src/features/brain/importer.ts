// Modified for the personal fork, October 2026. See NOTICE.
/**
 * Brain importer — unpacks a `.claudebrain.zip` written by exporter.ts
 * back onto disk. Caller confirms the destructive replace; existing
 * files at conflicting paths are overwritten.
 *
 * Merging mcpServers entries is still special-cased: they're written
 * back into the live `~/.claude.json` (not into a standalone file) so
 * the surrounding oauthAccount + userID + projects blocks survive.
 * Incoming entries replace same-named existing entries.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CLAUDE_DIR } from "../../core/config";
import { readZip, type ZipEntry } from "./zip";
import type { BrainManifest } from "./exporter";
import { resolveBrainPath, resolveUnlinkedPath } from "./surfaces";
import { writeFileAtomic } from "../../core/atomicWrite";
import { CONFIG_LOCK, withLocks, describeLockFailure } from "../account/claudeLocks";

export interface ImportSummary {
  /** Files written to a path that didn't exist before. */
  written: string[];
  /** Existing files whose contents were replaced by the incoming version. */
  overwritten: string[];
  /** Files in the archive we refused to restore (e.g. out-of-tree paths). */
  skipped: string[];
  /** mcpServers entry names written into ~/.claude.json (new or replaced). */
  mergedMcpServers: string[];
  /** Human-readable warnings to surface in the post-import toast. */
  warnings: string[];
}

export interface ConflictPreview {
  /** Destination paths that already exist and will be overwritten. */
  overwrites: string[];
  /** mcpServers entry names already present in ~/.claude.json. */
  mcpReplacements: string[];
}

/**
 * Write a file, creating parent directories. Overwrites existing
 * content when the bytes differ; skips the write when identical so
 * mtimes stay stable.
 */
function writeFileReplacing(
  absPath: string,
  data: Buffer,
  summary: ImportSummary,
): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const existed = fs.existsSync(absPath);
  if (existed) {
    try {
      const existing = fs.readFileSync(absPath);
      if (existing.equals(data)) {
        summary.written.push(absPath);
        return;
      }
    } catch {
      // unreadable — fall through and overwrite
    }
    writeFileAtomic(absPath, data);
    summary.overwritten.push(absPath);
    return;
  }
  writeFileAtomic(absPath, data);
  summary.written.push(absPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Missing config is safe to create; every unreadable or malformed existing file is preserved. */
function readLiveConfig(target: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${target} could not be read, so it was left untouched.`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && (parsed.mcpServers === undefined || isRecord(parsed.mcpServers))) return parsed;
  } catch { /* report the same refusal for any invalid existing config */ }
  throw new Error(`${target} isn't a valid config object, so it was left untouched. Fix or restore it before importing.`);
}

function incomingMcpServers(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : null;
  } catch { return null; }
}

/** Hold Claude's config lock across the complete read-modify-write, preserving account changes. */
function mergeMcpServers(raw: string, summary: ImportSummary): void {
  const incoming = incomingMcpServers(raw);
  if (!incoming) {
    summary.skipped.push("mcpServers (unparseable)");
    return;
  }
  if (Object.keys(incoming).length === 0) return;
  const result = withLocks([CONFIG_LOCK], () => {
    const target = resolveUnlinkedPath(os.homedir(), ".claude.json");
    if (!target) throw new Error("Claude config has a linked or invalid path and was left untouched.");
    const live = readLiveConfig(target);
    live.mcpServers = { ...(live.mcpServers as Record<string, unknown> | undefined), ...incoming };
    writeFileAtomic(target, JSON.stringify(live, null, 2));
    summary.mergedMcpServers.push(...Object.keys(incoming));
  });
  if (!result.ok) throw new Error(describeLockFailure(result.failure));
}

export function importBrain(
  zipBuf: Buffer,
  workspacePath: string | undefined,
  pickSections: Array<"global" | "project">,
): ImportSummary {
  const summary: ImportSummary = {
    written: [],
    overwritten: [],
    skipped: [],
    mergedMcpServers: [],
    warnings: [],
  };

  const entries = readZip(zipBuf);
  const manifestEntry = entries.find((e) => e.path === "brain-manifest.json");
  let manifest: BrainManifest | null = null;
  if (manifestEntry) {
    try {
      manifest = JSON.parse(manifestEntry.data.toString("utf-8")) as BrainManifest;
    } catch {
      // ignore; sections derive from entry prefixes below
    }
  }

  for (const entry of entries) {
    if (entry.path === "brain-manifest.json") continue;

    let section: "global" | "project" | null = null;
    let relative = "";
    if (entry.path.startsWith("global/")) {
      section = "global";
      relative = entry.path.slice("global/".length);
    } else if (entry.path.startsWith("project/")) {
      section = "project";
      relative = entry.path.slice("project/".length);
    } else {
      summary.skipped.push(entry.path);
      continue;
    }
    if (!pickSections.includes(section)) continue;

    if (section === "global") {
      // Special-case mcpServers.json — merge instead of overwriting
      // the live ~/.claude.json contents.
      if (relative === "mcpServers.json") {
        mergeMcpServers(entry.data.toString("utf-8"), summary);
        continue;
      }
      const abs = resolveBrainPath("global", CLAUDE_DIR, relative);
      if (!abs) {
        summary.skipped.push(entry.path);
        continue;
      }
      writeFileReplacing(abs, entry.data, summary);
      // settings.json from another machine often contains hooks
      // whose `command` begins with an absolute path only valid on
      // the source machine. Warn on import so users can fix them
      // before the next Claude session tries to run a missing
      // binary.
      if (relative === "settings.json") {
        const sourceWarnings = checkSettingsHookPaths(entry.data.toString("utf-8"));
        summary.warnings.push(...sourceWarnings);
      }
    } else if (section === "project") {
      if (!workspacePath) {
        summary.skipped.push(entry.path);
        continue;
      }
      const abs = resolveBrainPath("project", workspacePath, relative);
      if (!abs) {
        summary.skipped.push(entry.path);
        continue;
      }
      writeFileReplacing(abs, entry.data, summary);
      if (relative === ".claude/settings.json") {
        const sourceWarnings = checkSettingsHookPaths(entry.data.toString("utf-8"));
        summary.warnings.push(...sourceWarnings);
      }
    }
  }

  return summary;
}

/**
 * Inspect a settings.json blob for hooks whose `command` field starts
 * with an absolute path. Any such path that doesn't exist on the
 * importing machine becomes a warning in the summary, since the
 * Claude CLI would otherwise silently fail the hook at runtime with
 * ENOENT. Relative commands (`node script.js`) and plain shell words
 * (`echo hello`) are assumed fine — they resolve via $PATH.
 */
function checkSettingsHookPaths(raw: string): string[] {
  const warnings: string[] = [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return warnings;
  }
  const hooks = parsed.hooks as Record<string, unknown> | undefined;
  if (!hooks || typeof hooks !== "object") return warnings;

  for (const [eventName, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const inner = (matcher as { hooks?: unknown }).hooks;
      if (!Array.isArray(inner)) continue;
      for (const hook of inner) {
        const command = (hook as { command?: unknown }).command;
        if (typeof command !== "string" || !command.trim()) continue;
        // First token = the executable. Tokenise on whitespace (shell
        // quoting not unrolled; safe upper bound for the check).
        const first = command.trim().split(/\s+/)[0] ?? "";
        if (!path.isAbsolute(first)) continue;
        if (!fs.existsSync(first)) {
          warnings.push(
            `Hook in ${eventName} references missing path: ${first}`,
          );
        }
      }
    }
  }
  return warnings;
}

/**
 * Dry-run the import to enumerate what would be overwritten. Caller
 * uses this to build a precise confirmation dialog before the
 * destructive write. Pure read — no filesystem mutation.
 */
export function previewConflicts(
  zipBuf: Buffer,
  workspacePath: string | undefined,
  pickSections: Array<"global" | "project">,
): ConflictPreview {
  const overwrites: string[] = [];
  const mcpReplacements: string[] = [];
  let entries: ZipEntry[];
  try {
    entries = readZip(zipBuf);
  } catch {
    return { overwrites, mcpReplacements };
  }

  for (const entry of entries) {
    if (entry.path === "brain-manifest.json") continue;

    let section: "global" | "project" | null = null;
    let relative = "";
    if (entry.path.startsWith("global/")) {
      section = "global";
      relative = entry.path.slice("global/".length);
    } else if (entry.path.startsWith("project/")) {
      section = "project";
      relative = entry.path.slice("project/".length);
    } else {
      continue;
    }
    if (!pickSections.includes(section)) continue;

    if (section === "global" && relative === "mcpServers.json") {
      const incoming = incomingMcpServers(entry.data.toString("utf-8"));
      if (!incoming || Object.keys(incoming).length === 0) continue;
      const target = resolveUnlinkedPath(os.homedir(), ".claude.json");
      if (!target) throw new Error("Claude config has a linked or invalid path and was left untouched.");
      const live = readLiveConfig(target);
      const existing = (live.mcpServers as Record<string, unknown> | undefined) ?? {};
      for (const name of Object.keys(incoming)) {
        if (Object.hasOwn(existing, name)) mcpReplacements.push(name);
      }
      continue;
    }

    const root = section === "global" ? CLAUDE_DIR : workspacePath;
    if (!root) continue;
    const abs = resolveBrainPath(section, root, relative);
    if (!abs) continue;
    if (!fs.existsSync(abs)) continue;
    try {
      const existing = fs.readFileSync(abs);
      if (existing.equals(entry.data)) continue;
    } catch {
      // unreadable — count as overwrite candidate
    }
    overwrites.push(abs);
  }
  return { overwrites, mcpReplacements };
}

/** Expose just the manifest for pre-import UI (scope picker). */
export function readManifest(zipBuf: Buffer): BrainManifest | null {
  try {
    const entries = readZip(zipBuf);
    const m = entries.find((e) => e.path === "brain-manifest.json");
    if (!m) return null;
    return JSON.parse(m.data.toString("utf-8")) as BrainManifest;
  } catch {
    return null;
  }
}

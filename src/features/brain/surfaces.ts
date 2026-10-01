/** The only portable configuration surfaces a Brain archive may contain. */
import * as fs from "fs";
import * as path from "path";

export type BrainSection = "global" | "project";
export const GLOBAL_FILES = ["CLAUDE.md", "settings.json"] as const;
export const GLOBAL_DIRS = ["skills", "commands", "agents", "memory"] as const;
export const PROJECT_FILES = [
  "CLAUDE.md", ".mcp.json", ".claude/CLAUDE.md", ".claude/settings.json", ".claude/settings.local.json",
] as const;
export const PROJECT_DIRS = [".claude/skills", ".claude/commands", ".claude/agents", ".claude/memory"] as const;

function portableRelative(relative: string): boolean {
  if (!relative || /[\\:\x00-\x1f<>|?*"]/.test(relative)) return false;
  return relative.split("/").every((part) =>
    part !== "" && part !== "." && part !== ".." && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function isBrainSurface(section: BrainSection, relative: string): boolean {
  if (!portableRelative(relative)) return false;
  const files: readonly string[] = section === "global" ? GLOBAL_FILES : PROJECT_FILES;
  const dirs: readonly string[] = section === "global" ? GLOBAL_DIRS : PROJECT_DIRS;
  return (section === "global" && relative === "mcpServers.json") || files.includes(relative) || dirs.some((dir) => relative.startsWith(`${dir}/`));
}

/** Reject a linked root or ancestor, including Windows directory junctions. */
export function resolveUnlinkedPath(root: string, relative: string): string | null {
  if (!portableRelative(relative)) return null;
  const base = path.resolve(root);
  const destination = path.resolve(base, relative);
  if (!destination.startsWith(base + path.sep)) return null;
  let current = base;
  const parts = relative.split("/");
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i]);
    try {
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink()) return null;
      if (i < parts.length - 1 && !info.isDirectory()) return null;
      if (i === parts.length - 1 && !info.isFile()) return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      // Missing descendants will be created inside the last checked directory.
      break;
    }
  }
  return destination;
}

export function resolveBrainPath(section: BrainSection, root: string, relative: string): string | null {
  return isBrainSurface(section, relative) ? resolveUnlinkedPath(root, relative) : null;
}

/** Native CLI discovery affects terminal environment only; no shell command is built. */
import * as path from "path";

export interface ClaudeCliEnvironmentOptions {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
  isFile(filePath: string): boolean;
}

/** Append the installed standalone CLI's directory, preserving existing PATH priority. */
export function nativeClaudeTerminalEnvironment(
  options: ClaudeCliEnvironmentOptions,
): Record<string, string> | undefined {
  const windows = options.platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  if (!paths.isAbsolute(options.homeDirectory)) return undefined;
  const directory = paths.join(options.homeDirectory, ".local", "bin");
  const executable = paths.join(directory, windows ? "claude.exe" : "claude");
  try { if (!options.isFile(executable)) return undefined; }
  catch { return undefined; }

  const key = windows
    ? Object.keys(options.environment).find(name => name.toLowerCase() === "path") ?? "PATH"
    : "PATH";
  const existing = options.environment[key] ?? "";
  const delimiter = windows ? ";" : ":";
  const normalize = (entry: string): string => {
    const normalized = paths.normalize(entry).replace(windows ? /[\\/]+$/ : /\/+$/, "");
    return windows ? normalized.toLowerCase() : normalized;
  };
  const expected = normalize(directory);
  if (existing.split(delimiter).some(entry => entry !== "" && normalize(entry) === expected)) return undefined;
  return { [key]: existing ? `${existing}${existing.endsWith(delimiter) ? "" : delimiter}${directory}` : directory };
}

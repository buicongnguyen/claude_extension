/** One encrypted commit contains identity, credentials and display metadata. */
import * as fs from "fs";
import * as path from "path";
import { readProfileFile, writeProfileFile } from "./profileVault";

export const SNAPSHOT_FILE = "profile.enc";
export interface AccountSnapshot {
  version: 2;
  claudeJsonRaw: string;
  credsRaw: string;
  label: string;
  savedAt: string;
}
function validateSnapshot(value: AccountSnapshot): AccountSnapshot {
  const config = JSON.parse(value.claudeJsonRaw);
  const credentials = JSON.parse(value.credsRaw);
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      typeof credentials?.claudeAiOauth?.accessToken !== "string" || !credentials.claudeAiOauth.accessToken) {
    throw new Error("Saved account is missing a usable identity or credential payload.");
  }
  return value;
}

export function readAccountSnapshot(directory: string): AccountSnapshot {
  const file = path.join(directory, SNAPSHOT_FILE);
  if (fs.existsSync(file)) {
    const value = JSON.parse(readProfileFile(file)) as AccountSnapshot;
    if (value.version !== 2 || typeof value.claudeJsonRaw !== "string" || typeof value.credsRaw !== "string" ||
        typeof value.label !== "string" || typeof value.savedAt !== "string") {
      throw new Error("Saved account has an unsupported snapshot format.");
    }
    return validateSnapshot(value);
  }
  // Read 2.15.2 encrypted snapshots, but never write another multi-file snapshot.
  // A damaged new snapshot must never silently fall back to stale legacy tokens.
  const claudeJsonRaw = readProfileFile(path.join(directory, ".claude.json"));
  const credsRaw = readProfileFile(path.join(directory, ".credentials.json"));
  let metadata: { label?: string; savedAt?: string } = {};
  try { metadata = JSON.parse(fs.readFileSync(path.join(directory, "profile.json"), "utf8")); } catch { /* legacy metadata optional */ }
  return validateSnapshot({ version: 2, claudeJsonRaw, credsRaw,
    label: typeof metadata.label === "string" ? metadata.label : path.basename(directory),
    savedAt: typeof metadata.savedAt === "string" ? metadata.savedAt : "" });
}

export function writeAccountSnapshot(directory: string, snapshot: AccountSnapshot): void {
  writeProfileFile(path.join(directory, SNAPSHOT_FILE), JSON.stringify(validateSnapshot(snapshot)));
}

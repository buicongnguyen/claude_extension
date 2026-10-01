/** Recoverable two-file live-login transaction. Call writes while Claude locks are held. */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { getProfileDirectory, readProfileFile, writeProfileFile } from "./profileVault";
import { readCredentialsStatus, writeCredentials, deleteCredentials, hashCredentials, defaultTargetSource, type CredentialsSource } from "./credentials";
import { clearClaudeJsonCache } from "./claudeJsonCache";
import { withLocks, CREDENTIAL_LOCKS, CONFIG_LOCK, describeLockFailure } from "./claudeLocks";

const configFile = path.join(os.homedir(), ".claude.json");
export const SWITCH_BACKUP = configFile + ".manager-personal.bak";
const journalFile = () => path.join(getProfileDirectory(), ".switch-recovery.enc");
export type SwitchWriteResult = { ok: true } | { ok: false; error: "copy-failed" | "recovery-required"; detail: string };
interface Journal {
  version: 1;
  beforeConfig: string | null;
  beforeCredentials: string | null;
  afterConfig: string;
  afterCredentialsHash: string;
  source: CredentialsSource;
}
const recoveryError = (): SwitchWriteResult => ({ ok: false, error: "recovery-required", detail:
  "The previous account switch needs recovery. Its encrypted recovery record and backup were kept. Stop Claude sessions and retry switching or reload VS Code. If the live login was changed separately, restore it deliberately before retrying; no unknown login will be overwritten." });
const copyError = (): SwitchWriteResult => ({ ok: false, error: "copy-failed", detail: "The account switch failed. The previous login was restored." });
function readConfig(): string | null {
  try { return fs.readFileSync(configFile, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function replaceConfig(raw: string | null): void {
  if (raw === null) { fs.rmSync(configFile, { force: true }); return; }
  const temp = `${configFile}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, raw, { flag: "wx", mode: 0o600 }); fs.renameSync(temp, configFile); }
  finally { try { fs.rmSync(temp, { force: true }); } catch { /* preserve operation result */ } }
}
export function hasPendingSwitch(): boolean { return fs.existsSync(journalFile()); }

/** Under the same locks as switching; never overwrite an unrelated later login. */
export function recoverPendingSwitchUnlocked(): SwitchWriteResult {
  if (!hasPendingSwitch()) return { ok: true };
  try {
    const entry = JSON.parse(readProfileFile(journalFile())) as Journal;
    if (entry.version !== 1 || (entry.beforeConfig !== null && typeof entry.beforeConfig !== "string") ||
        (entry.beforeCredentials !== null && typeof entry.beforeCredentials !== "string") ||
        typeof entry.afterConfig !== "string" || typeof entry.afterCredentialsHash !== "string" ||
        !entry.source || !["file", "keychain-darwin"].includes(entry.source.kind) || typeof entry.source.locator !== "string") return recoveryError();
    const currentConfig = readConfig();
    const currentStatus = readCredentialsStatus({ fresh: true });
    if (currentStatus.state === "transient") return recoveryError();
    const currentHash = currentStatus.state === "ok" ? currentStatus.live.hash : null;
    const oldHash = entry.beforeCredentials === null ? null : hashCredentials(entry.beforeCredentials);
    const configBefore = currentConfig === entry.beforeConfig;
    const configAfter = currentConfig === entry.afterConfig;
    const credentialsBefore = currentHash === oldHash;
    const credentialsAfter = currentHash === entry.afterCredentialsHash;
    if ((!configBefore && !configAfter) || (!credentialsBefore && !credentialsAfter)) return recoveryError();
    // Both new files means the transaction committed before the crash. Keep that login.
    if (!(configAfter && credentialsAfter)) {
      if (!configBefore) {
        if (entry.beforeConfig !== null && fs.existsSync(SWITCH_BACKUP) && fs.readFileSync(SWITCH_BACKUP, "utf8") === entry.beforeConfig) {
          fs.copyFileSync(SWITCH_BACKUP, configFile);
        } else {
          replaceConfig(entry.beforeConfig);
        }
      }
      if (!credentialsBefore) {
        const restored = entry.beforeCredentials === null ? deleteCredentials(entry.source) : writeCredentials(entry.beforeCredentials, entry.source);
        if (!restored) return recoveryError();
      }
      const restoredStatus = readCredentialsStatus({ fresh: true });
      if (restoredStatus.state === "transient") return recoveryError();
      const restoredHash = restoredStatus.state === "ok" ? restoredStatus.live.hash : null;
      if (readConfig() !== entry.beforeConfig || restoredHash !== oldHash) return recoveryError();
    }
    // Recovery data is removed only after a verified, consistent result.
    fs.rmSync(SWITCH_BACKUP, { force: true });
    fs.rmSync(journalFile());
    clearClaudeJsonCache();
    return { ok: true };
  } catch { return recoveryError(); }
}

export function recoverPendingSwitch(): SwitchWriteResult {
  if (!hasPendingSwitch()) return { ok: true };
  const result = withLocks([...CREDENTIAL_LOCKS, CONFIG_LOCK], recoverPendingSwitchUnlocked);
  return result.ok ? result.value : { ok: false, error: "recovery-required", detail: describeLockFailure(result.failure) };
}

export function writeLiveAccount(afterConfig: string, credentials: string): SwitchWriteResult {
  const recovery = recoverPendingSwitchUnlocked();
  if (!recovery.ok) return recovery;
  // An orphan backup may be the only remaining recovery copy: never erase it.
  if (fs.existsSync(SWITCH_BACKUP)) return recoveryError();
  try {
    const beforeConfig = readConfig();
    const beforeStatus = readCredentialsStatus({ fresh: true });
    if (beforeStatus.state === "transient") return { ok: false, error: "copy-failed", detail:
      "Claude's current credentials could not be read. No login files were changed. Unlock its credential store or retry after login finishes." };
    const before = beforeStatus.state === "ok" ? beforeStatus.live : null;
    const source = before?.source ?? defaultTargetSource();
    const entry: Journal = { version: 1, beforeConfig, beforeCredentials: before?.raw ?? null,
      afterConfig, afterCredentialsHash: hashCredentials(credentials), source };
    writeProfileFile(journalFile(), JSON.stringify(entry));
    if (beforeConfig !== null) fs.writeFileSync(SWITCH_BACKUP, beforeConfig, { flag: "wx", mode: 0o600 });
    replaceConfig(afterConfig);
    if (!writeCredentials(credentials, source)) {
      const restored = recoverPendingSwitchUnlocked();
      return restored.ok ? copyError() : restored;
    }
    // Also handles a crash after the second write but before commit cleanup.
    return recoverPendingSwitchUnlocked();
  } catch {
    const restored = recoverPendingSwitchUnlocked();
    return restored.ok ? copyError() : restored;
  }
}

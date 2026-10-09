/** Recoverable two-file live-login transaction. Call writes while Claude locks are held. */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { getProfileDirectory, readProfileFile, writeProfileFile } from "./profileVault";
import { readCredentialsStatus, writeCredentials, deleteCredentials, hashCredentials, defaultTargetSource, type CredentialsSource } from "./credentials";
import { clearClaudeJsonCache } from "./claudeJsonCache";
import { withLocks, CREDENTIAL_LOCKS, CONFIG_LOCK, describeLockFailure } from "./claudeLocks";
import { auditAccountEvent, safeAccountErrorCode } from "./accountAudit";

type AuditStage = NonNullable<Parameters<typeof auditAccountEvent>[1]>["stage"];
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
  let stage: AuditStage = "recovery_read";
  let rollingBack = false;
  let verifying = false;
  const fail = (reason: "invalid_journal" | "unknown_live_state" | "transient_store" | "backend_failed" | "required", error?: unknown): SwitchWriteResult => {
    const fields = { stage, reason, code: error === undefined ? "recovery-required" as const : safeAccountErrorCode(error) };
    if (verifying) auditAccountEvent("verify_failed", fields);
    if (rollingBack) auditAccountEvent("rollback_failed", fields);
    auditAccountEvent("recovery_failed", fields);
    return recoveryError();
  };
  auditAccountEvent("recovery_started", { stage });
  try {
    const entry = JSON.parse(readProfileFile(journalFile())) as Journal;
    stage = "recovery_validate";
    if (entry.version !== 1 || (entry.beforeConfig !== null && typeof entry.beforeConfig !== "string") ||
        (entry.beforeCredentials !== null && typeof entry.beforeCredentials !== "string") ||
        typeof entry.afterConfig !== "string" || typeof entry.afterCredentialsHash !== "string" ||
        !entry.source || !["file", "keychain-darwin"].includes(entry.source.kind) || typeof entry.source.locator !== "string") return fail("invalid_journal");
    stage = "recovery_compare";
    verifying = true;
    auditAccountEvent("verify_started", { stage });
    const currentConfig = readConfig();
    const currentStatus = readCredentialsStatus({ fresh: true });
    if (currentStatus.state === "transient") return fail("transient_store");
    const currentHash = currentStatus.state === "ok" ? currentStatus.live.hash : null;
    const oldHash = entry.beforeCredentials === null ? null : hashCredentials(entry.beforeCredentials);
    const configBefore = currentConfig === entry.beforeConfig;
    const configAfter = currentConfig === entry.afterConfig;
    const credentialsBefore = currentHash === oldHash;
    const credentialsAfter = currentHash === entry.afterCredentialsHash;
    if ((!configBefore && !configAfter) || (!credentialsBefore && !credentialsAfter)) return fail("unknown_live_state");
    verifying = false;
    // Both new files means the transaction committed before the crash. Keep that login.
    const committed = configAfter && credentialsAfter;
    if (!committed) {
      auditAccountEvent("verify_completed", { stage });
      rollingBack = true;
      auditAccountEvent("rollback_started", { stage });
      stage = "recovery_config_restore";
      if (!configBefore) {
        if (entry.beforeConfig !== null && fs.existsSync(SWITCH_BACKUP) && fs.readFileSync(SWITCH_BACKUP, "utf8") === entry.beforeConfig) {
          fs.copyFileSync(SWITCH_BACKUP, configFile);
        } else {
          replaceConfig(entry.beforeConfig);
        }
      }
      stage = "recovery_credentials_restore";
      if (!credentialsBefore) {
        const restored = entry.beforeCredentials === null ? deleteCredentials(entry.source) : writeCredentials(entry.beforeCredentials, entry.source);
        if (!restored) return fail("backend_failed");
      }
      stage = "recovery_verify";
      verifying = true;
      auditAccountEvent("verify_started", { stage });
      const restoredStatus = readCredentialsStatus({ fresh: true });
      if (restoredStatus.state === "transient") return fail("transient_store");
      const restoredHash = restoredStatus.state === "ok" ? restoredStatus.live.hash : null;
      if (readConfig() !== entry.beforeConfig || restoredHash !== oldHash) return fail("unknown_live_state");
      verifying = false;
      auditAccountEvent("verify_completed", { stage, reason: "restored" });
      rollingBack = false;
      auditAccountEvent("rollback_completed", { stage, reason: "restored" });
    } else {
      // Record the verified commit before cleanup, which can fail independently.
      auditAccountEvent("verify_completed", { stage: "commit_verify", reason: "committed" });
    }
    // Recovery data is removed only after a verified, consistent result.
    stage = "recovery_cleanup_backup";
    fs.rmSync(SWITCH_BACKUP, { force: true });
    stage = "recovery_cleanup_journal";
    fs.rmSync(journalFile());
    clearClaudeJsonCache();
    auditAccountEvent("recovery_completed", { stage, reason: committed ? "committed" : "restored" });
    return { ok: true };
  } catch (error) { return fail("required", error); }
}

export function recoverPendingSwitch(): SwitchWriteResult {
  if (!hasPendingSwitch()) return { ok: true };
  const result = withLocks([...CREDENTIAL_LOCKS, CONFIG_LOCK], recoverPendingSwitchUnlocked);
  if (!result.ok) {
    auditAccountEvent("locks_failed", { stage: "locks", code: "recovery-required", reason: result.failure.reason });
    auditAccountEvent("recovery_failed", { stage: "locks", code: "recovery-required", reason: result.failure.reason });
  }
  return result.ok ? result.value : { ok: false, error: "recovery-required", detail: describeLockFailure(result.failure) };
}

export function writeLiveAccount(afterConfig: string, credentials: string): SwitchWriteResult {
  const recovery = recoverPendingSwitchUnlocked();
  if (!recovery.ok) return recovery;
  let stage: AuditStage = "backup_check";
  auditAccountEvent("apply_started", { stage });
  // An orphan backup may be the only remaining recovery copy: never erase it.
  if (fs.existsSync(SWITCH_BACKUP)) {
    auditAccountEvent("apply_failed", { stage, code: "recovery-required", reason: "required" });
    return recoveryError();
  }
  try {
    stage = "read_before";
    auditAccountEvent("apply_started", { stage });
    const beforeConfig = readConfig();
    const beforeStatus = readCredentialsStatus({ fresh: true });
    if (beforeStatus.state === "transient") {
      auditAccountEvent("apply_failed", { stage, code: "copy-failed", reason: "transient_store" });
      return { ok: false, error: "copy-failed", detail:
        "Claude's current credentials could not be read. No login files were changed. Unlock its credential store or retry after login finishes." };
    }
    const before = beforeStatus.state === "ok" ? beforeStatus.live : null;
    const source = before?.source ?? defaultTargetSource();
    const entry: Journal = { version: 1, beforeConfig, beforeCredentials: before?.raw ?? null,
      afterConfig, afterCredentialsHash: hashCredentials(credentials), source };
    stage = "write_journal";
    auditAccountEvent("apply_started", { stage });
    writeProfileFile(journalFile(), JSON.stringify(entry));
    auditAccountEvent("apply_completed", { stage });
    stage = "backup_create";
    auditAccountEvent("apply_started", { stage });
    if (beforeConfig !== null) fs.writeFileSync(SWITCH_BACKUP, beforeConfig, { flag: "wx", mode: 0o600 });
    auditAccountEvent("apply_completed", { stage });
    stage = "config_replace";
    auditAccountEvent("apply_started", { stage });
    replaceConfig(afterConfig);
    auditAccountEvent("apply_completed", { stage });
    stage = "credentials_write";
    auditAccountEvent("apply_started", { stage });
    if (!writeCredentials(credentials, source)) {
      auditAccountEvent("apply_failed", { stage, code: "copy-failed", reason: "backend_failed" });
      const restored = recoverPendingSwitchUnlocked();
      return restored.ok ? copyError() : restored;
    }
    auditAccountEvent("apply_completed", { stage });
    // Also handles a crash after the second write but before commit cleanup.
    const committed = recoverPendingSwitchUnlocked();
    if (committed.ok) auditAccountEvent("apply_completed", { stage: "commit_verify" });
    return committed;
  } catch (error) {
    auditAccountEvent("apply_failed", { stage, code: safeAccountErrorCode(error), reason: "backend_failed" });
    const restored = recoverPendingSwitchUnlocked();
    return restored.ok ? copyError() : restored;
  }
}

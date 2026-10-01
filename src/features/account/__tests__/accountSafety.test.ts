/** Review-only safety assertions, using synthetic accounts and an isolated home. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const fixture = vi.hoisted(() => {
  const f = require("fs") as typeof import("fs");
  const p = require("path") as typeof import("path");
  const o = require("os") as typeof import("os");
  const home = f.mkdtempSync(p.join(o.tmpdir(), "manager-review-"));
  return { home, claude: p.join(home, ".claude"), vault: p.join(home, "vault") };
});
vi.mock("os", async (original) => ({ ...(await original<typeof import("os")>()), homedir: () => fixture.home }));
vi.mock("../../../core/config", () => ({ CLAUDE_DIR: fixture.claude }));
vi.mock("fs", async (original) => ({ ...(await original<typeof import("fs")>()) }));

import { closeProfileVault, initializeProfileVault, writeProfileFile } from "../profileVault";
import { saveProfile, switchProfile, syncActiveProfile, updateProfile, captureProfileUpdate } from "../profiles";
import { clearClaudeJsonCache } from "../claudeJsonCache";

import { readAccountSnapshot, SNAPSHOT_FILE } from "../accountSnapshot";
import { SWITCH_BACKUP, recoverPendingSwitch, hasPendingSwitch } from "../liveSwitch";
import { updateProfileWithConfirmation, switchProfileWithConfirmation } from "../../sessions/profileActions";
import * as vscode from "vscode";

let secrets: Map<string, string>;
const storage = { get: async (name: string) => secrets.get(name), store: async (name: string, raw: string) => { secrets.set(name, raw); } };
const config = path.join(fixture.home, ".claude.json");
const credentials = path.join(fixture.claude, ".credentials.json");
const slotFile = (slug: string, file: string) => path.join(fixture.vault, slug, file);
function writeIdentity(account: string) {
  fs.writeFileSync(config, JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: `${account}@example.test` }, userID: "same-device", projects: { preserved: true } }));
  clearClaudeJsonCache();
}
function writeTokens(account: string) {
  fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-oat01-synthetic-${account}`, refreshToken: `synthetic-refresh-${account}`, expiresAt: 9999999999999 } }));
}
function login(account: string) { writeIdentity(account); writeTokens(account); }
beforeEach(async () => {
  fs.mkdirSync(fixture.claude, { recursive: true });
  secrets = new Map();
  await initializeProfileVault(storage, fixture.vault);
  clearClaudeJsonCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  closeProfileVault();
  const resolved = path.resolve(fixture.home);
  if (!path.basename(resolved).startsWith("manager-review-") || path.dirname(resolved) !== path.resolve(require("os").tmpdir())) throw Error("Unsafe test cleanup");
  fs.rmSync(resolved, { recursive: true, force: true });
});

describe("review: account preservation under transitions and failures", () => {
  it("preserves account 1 when new opaque tokens arrive before the new identity", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    const saved = readAccountSnapshot(path.join(fixture.vault, "account-1")).credsRaw;
    // /login is between its credentials write and its identity/config write.
    writeTokens("bob");
    syncActiveProfile();
    writeIdentity("bob");
    syncActiveProfile();
    expect(readAccountSnapshot(path.join(fixture.vault, "account-1")).credsRaw).toBe(saved);
  });

  it("keeps a recovery backup when credential writing and identity rollback both fail", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    login("bob"); expect(saveProfile("Account 2").ok).toBe(true);
    const originalRename = fs.renameSync;
    const originalCopy = fs.copyFileSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === credentials) throw Object.assign(Error("synthetic write failure"), { code: "EACCES" });
      return originalRename(from, to);
    });
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, flags) => {
      if (String(from) === SWITCH_BACKUP) throw Object.assign(Error("synthetic rollback failure"), { code: "EACCES" });
      return originalCopy(from, to, flags);
    });
    expect(switchProfile("account-1").ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(config, "utf8")).oauthAccount.accountUuid).toBe("alice");
    expect(fs.readFileSync(credentials, "utf8")).toContain("synthetic-bob");
    expect(fs.existsSync(SWITCH_BACKUP)).toBe(true);
  });

  it("keeps the entire saved snapshot when the atomic commit fails", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    const oldIdentity = readAccountSnapshot(path.join(fixture.vault, "account-1")).claudeJsonRaw;
    writeIdentity("alice");
    const edited = JSON.parse(fs.readFileSync(config, "utf8"));
    edited.oauthAccount.emailAddress = "alice-new@example.test";
    fs.writeFileSync(config, JSON.stringify(edited)); clearClaudeJsonCache();
    writeTokens("alice-refreshed");
    const originalRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === slotFile("account-1", SNAPSHOT_FILE)) throw Error("synthetic second-write failure");
      return originalRename(from, to);
    });
    const approval = captureProfileUpdate("account-1");
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;
    expect(updateProfile("account-1", approval.data)).toMatchObject({ ok: false, error: "copy-failed" });
    expect(fs.renameSync).toHaveBeenCalled();
    expect(readAccountSnapshot(path.join(fixture.vault, "account-1")).claudeJsonRaw).toBe(oldIdentity);
  });

  it("allows two normal startup attempts to finish after temporary initialization contention", async () => {
    closeProfileVault();
    let unblock!: () => void;
    const barrier = new Promise<void>((resolve) => { unblock = resolve; });
    let firstRead = true;
    const slowStorage = { ...storage, get: async (name: string) => {
      if (firstRead) { firstRead = false; await barrier; }
      return secrets.get(name);
    }};
    const first = initializeProfileVault(slowStorage, fixture.vault);
    const second = initializeProfileVault(storage, fixture.vault);
    const result = Promise.allSettled([first, second]);
    unblock();
    expect((await result).map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  });

  it("rejects a snapshot refresh when the account changed after the picker opened", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    // Picker's active row and its Update button still refer to account-1.
    login("bob");
    const result = updateProfile("account-1");
    expect(result.ok).toBe(false);
  });

  it("requires confirmation for a full opaque rotation, then preserves it across a round trip", async () => {
    login("alice"); saveProfile("Account 1");
    login("bob"); saveProfile("Account 2");
    writeTokens("bob-rotated");
    expect(syncActiveProfile()).toBeNull();
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "identity-unverified" });
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Confirm same account" as never);
    expect((await switchProfileWithConfirmation("account-1")).ok).toBe(true);
    expect(switchProfile("account-2").ok).toBe(true);
    expect(fs.readFileSync(credentials, "utf8")).toContain("synthetic-bob-rotated");
  });

  it("leaves both saved and live tokens untouched when confirmation is cancelled", async () => {
    login("alice"); saveProfile("Account 1");
    const saved = readAccountSnapshot(path.join(fixture.vault, "account-1"));
    writeTokens("alice-rotated");
    const live = fs.readFileSync(credentials, "utf8");
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    expect((await updateProfileWithConfirmation("account-1")).ok).toBe(false);
    expect(readAccountSnapshot(path.join(fixture.vault, "account-1"))).toEqual(saved);
    expect(fs.readFileSync(credentials, "utf8")).toBe(live);
  });

  it("rejects tokens changing again while confirmation is open", async () => {
    login("alice"); saveProfile("Account 1");
    const saved = readAccountSnapshot(path.join(fixture.vault, "account-1"));
    writeTokens("alice-rotated");
    vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(async () => {
      writeTokens("another-login");
      return "Confirm same account" as never;
    });
    expect(await updateProfileWithConfirmation("account-1")).toMatchObject({ ok: false, error: "stale-confirmation" });
    expect(readAccountSnapshot(path.join(fixture.vault, "account-1"))).toEqual(saved);
  });

  it("rejects a different saved generation after confirmation was captured", () => {
    login("alice"); saveProfile("Account 1");
    writeTokens("alice-rotated");
    const approval = captureProfileUpdate("account-1");
    expect(approval.ok).toBe(true); if (!approval.ok) return;
    const saved = readAccountSnapshot(path.join(fixture.vault, "account-1"));
    writeProfileFile(slotFile("account-1", SNAPSHOT_FILE), JSON.stringify({ ...saved, label: "Changed in another window" }));
    expect(updateProfile("account-1", approval.data)).toMatchObject({ ok: false, error: "stale-confirmation" });
  });

  it("does not restore stale tokens when asked to switch to the already active account", () => {
    login("alice"); saveProfile("Account 1");
    writeTokens("alice-rotated");
    const before = fs.readFileSync(credentials, "utf8");
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "identity-unverified" });
    expect(fs.readFileSync(credentials, "utf8")).toBe(before);
  });

  function interruptSwitch() {
    login("alice"); saveProfile("Account 1");
    login("bob"); saveProfile("Account 2");
    const originalRename = fs.renameSync, originalCopy = fs.copyFileSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === credentials) throw Error("synthetic credential failure");
      return originalRename(from, to);
    });
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, flags) => {
      if (String(from) === SWITCH_BACKUP) throw Error("synthetic rollback failure");
      return originalCopy(from, to, flags);
    });
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "recovery-required" });
    vi.restoreAllMocks();
  }

  it("recovers an interrupted switch after reopening the vault", async () => {
    interruptSwitch();
    expect(hasPendingSwitch()).toBe(true);
    closeProfileVault(); await initializeProfileVault(storage, fixture.vault);
    expect(recoverPendingSwitch()).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(config, "utf8")).oauthAccount.accountUuid).toBe("bob");
    expect(fs.readFileSync(credentials, "utf8")).toContain("synthetic-bob");
    expect(hasPendingSwitch()).toBe(false);
    expect(fs.existsSync(SWITCH_BACKUP)).toBe(false);
  });

  it("does not overwrite an unrelated later login during recovery", () => {
    interruptSwitch();
    login("charlie");
    const before = fs.readFileSync(credentials, "utf8");
    expect(recoverPendingSwitch()).toMatchObject({ ok: false, error: "recovery-required" });
    expect(fs.readFileSync(credentials, "utf8")).toBe(before);
    expect(hasPendingSwitch()).toBe(true);
    expect(saveProfile("Charlie")).toMatchObject({ ok: false, error: "recovery-required" });
    expect(syncActiveProfile()).toBeNull();
  });

  it("keeps the completed new login when a crash interrupts only commit cleanup", async () => {
    login("alice"); saveProfile("Account 1");
    login("bob"); saveProfile("Account 2");
    const originalRemove = fs.rmSync;
    vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
      if (String(file) === path.join(fixture.vault, ".switch-recovery.enc")) throw Error("synthetic interrupted commit cleanup");
      return originalRemove(file, options);
    });
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "recovery-required" });
    vi.restoreAllMocks();
    closeProfileVault(); await initializeProfileVault(storage, fixture.vault);
    expect(recoverPendingSwitch()).toEqual({ ok: true });
    expect(fs.readFileSync(credentials, "utf8")).toContain("synthetic-alice");
    expect(JSON.parse(fs.readFileSync(config, "utf8")).oauthAccount.accountUuid).toBe("alice");
  });

  it("retains an orphan backup instead of silently deleting it", () => {
    login("alice"); saveProfile("Account 1");
    login("bob"); saveProfile("Account 2");
    fs.writeFileSync(SWITCH_BACKUP, "existing recovery data");
    const before = fs.readFileSync(credentials, "utf8");
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "recovery-required" });
    expect(fs.readFileSync(SWITCH_BACKUP, "utf8")).toBe("existing recovery data");
    expect(fs.readFileSync(credentials, "utf8")).toBe(before);
  });

  it("upgrades a legacy encrypted slot atomically and never falls back after new-format damage", () => {
    login("alice");
    const directory = path.join(fixture.vault, "legacy");
    fs.mkdirSync(directory);
    writeProfileFile(path.join(directory, ".claude.json"), fs.readFileSync(config, "utf8"));
    writeProfileFile(path.join(directory, ".credentials.json"), fs.readFileSync(credentials, "utf8"));
    fs.writeFileSync(path.join(directory, "profile.json"), JSON.stringify({ label: "Legacy", savedAt: "2026-01-01" }));
    expect(updateProfile("legacy").ok).toBe(true);
    expect(readAccountSnapshot(directory).label).toBe("Legacy");
    fs.writeFileSync(path.join(directory, SNAPSHOT_FILE), "damaged new snapshot");
    expect(() => readAccountSnapshot(directory)).toThrow();
    expect(switchProfile("legacy").ok).toBe(false);
  });
});

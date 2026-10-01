/** Credential mutations use fresh synthetic backends, never a real Keychain. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const fixture = vi.hoisted(() => {
  const f = require("fs") as typeof import("fs");
  const p = require("path") as typeof import("path");
  const o = require("os") as typeof import("os");
  const home = f.mkdtempSync(p.join(o.tmpdir(), "manager-keychain-mutations-"));
  return { home, claude: p.join(home, ".claude"), vault: p.join(home, "vault") };
});
const security = vi.hoisted(() => vi.fn());
vi.mock("os", async (original) => ({
  ...(await original<typeof import("os")>()),
  homedir: () => fixture.home,
  userInfo: () => ({ username: "synthetic-user" }),
}));
vi.mock("../../../core/config", () => ({ CLAUDE_DIR: fixture.claude }));
vi.mock("fs", async (original) => ({ ...(await original<typeof import("fs")>()) }));
vi.mock("child_process", () => ({ execFileSync: (...args: unknown[]) => security(...args) }));

import { closeProfileVault, initializeProfileVault } from "../profileVault";
import { readAccountSnapshot } from "../accountSnapshot";
import { readCredentials, __internals } from "../credentials";
import { clearClaudeJsonCache } from "../claudeJsonCache";
import { saveProfile, switchProfile } from "../profiles";
import { hasPendingSwitch, recoverPendingSwitch, writeLiveAccount } from "../liveSwitch";
import { withLocks, CREDENTIAL_LOCKS, CONFIG_LOCK } from "../claudeLocks";
import { switchProfileWithConfirmation } from "../../sessions/profileActions";

const originalPlatform = process.platform;
const config = path.join(fixture.home, ".claude.json");
const credentialFile = path.join(fixture.claude, ".credentials.json");
const journal = path.join(fixture.vault, ".switch-recovery.enc");
let keychainRaw: string;
let denyRead: boolean;
const tokens = (account: string, generation = "old") => JSON.stringify({ claudeAiOauth: {
  accessToken: `synthetic-access-${account}-${generation}`,
  refreshToken: `synthetic-refresh-${account}-${generation}`,
} });
function login(account: string) {
  fs.writeFileSync(config, JSON.stringify({ oauthAccount: { accountUuid: account,
    emailAddress: `${account}@example.test` }, userID: "synthetic-device", projects: { preserved: true } }));
  keychainRaw = tokens(account);
  clearClaudeJsonCache();
  __internals.invalidateKeychainCache();
}
function snapshot(slug: string) { return readAccountSnapshot(path.join(fixture.vault, slug)); }
function seedAccounts() {
  login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
  login("bob"); expect(saveProfile("Account 2").ok).toBe(true);
}
function leaveCommittedJournal() {
  seedAccounts();
  const remove = fs.rmSync;
  const failCleanup = vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
    if (String(file) === journal) throw Error("Synthetic interrupted journal cleanup");
    return remove(file, options);
  });
  expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "recovery-required" });
  failCleanup.mockRestore();
  expect(hasPendingSwitch()).toBe(true);
}

beforeEach(async () => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  fs.mkdirSync(fixture.claude, { recursive: true });
  keychainRaw = ""; denyRead = false;
  security.mockReset();
  security.mockImplementation((_binary: string, args: string[]) => {
    if (args[0] === "find-generic-password") {
      const service = args[args.indexOf("-s") + 1];
      if (denyRead) throw Object.assign(Error("Synthetic denied read"), { status: 51 });
      if (!keychainRaw || service !== __internals.KEYCHAIN_SERVICE) {
        throw Object.assign(Error("Synthetic absent item"), { status: 44 });
      }
      return keychainRaw;
    }
    if (args[0] === "add-generic-password") {
      keychainRaw = args[args.indexOf("-w") + 1];
      // Reads could succeed after an authorized write; mutation must still
      // refuse to overwrite an unknown outgoing login in the first place.
      denyRead = false;
      return "";
    }
    if (args[0] === "delete-generic-password") { keychainRaw = ""; return ""; }
    throw Error("Unexpected synthetic Keychain operation");
  });
  __internals.invalidateKeychainCache();
  clearClaudeJsonCache();
  const secrets = new Map<string, string>();
  await initializeProfileVault({ get: async (name) => secrets.get(name),
    store: async (name, value) => { secrets.set(name, value); } }, fixture.vault);
});
afterEach(() => {
  closeProfileVault();
  vi.restoreAllMocks();
  __internals.invalidateKeychainCache();
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (!path.basename(fixture.home).startsWith("manager-keychain-mutations-")) throw Error("Unsafe test cleanup");
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

describe("fresh reads under account mutation locks", () => {
  it("preserves a refresh completed after the UI cached the outgoing Keychain login", () => {
    seedAccounts(); login("alice"); readCredentials();
    const rotated = JSON.parse(tokens("alice"));
    rotated.claudeAiOauth.refreshToken = "synthetic-fresh-refresh-alice";
    keychainRaw = JSON.stringify(rotated);
    expect(switchProfile("account-2").ok).toBe(true);
    expect(snapshot("account-1").credsRaw).toBe(JSON.stringify(rotated));
    expect(keychainRaw).toBe(tokens("bob"));
    expect(switchProfile("account-1").ok).toBe(true);
    expect(keychainRaw).toBe(JSON.stringify(rotated));
  });

  it("requires confirmation for two changed opaque tokens hidden by a prior UI read", async () => {
    seedAccounts(); login("alice"); readCredentials();
    keychainRaw = tokens("alice", "rotated");
    expect(switchProfile("account-2")).toMatchObject({ ok: false, error: "identity-unverified" });
    expect(keychainRaw).toBe(tokens("alice", "rotated"));
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Confirm same account" as never);
    expect((await switchProfileWithConfirmation("account-2")).ok).toBe(true);
    expect(warning).toHaveBeenCalledOnce();
    expect(snapshot("account-1").credsRaw).toBe(tokens("alice", "rotated"));
  });

  it("does not replace a denied current login or create a recovery journal", () => {
    seedAccounts(); readCredentials();
    keychainRaw = tokens("bob", "rotated"); denyRead = true;
    const beforeConfig = fs.readFileSync(config, "utf8");
    const beforeSnapshot = snapshot("account-2");
    security.mockClear();
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "unreadable-source" });
    expect(keychainRaw).toBe(tokens("bob", "rotated"));
    expect(fs.readFileSync(config, "utf8")).toBe(beforeConfig);
    expect(snapshot("account-2")).toEqual(beforeSnapshot);
    expect(hasPendingSwitch()).toBe(false);
    expect(security.mock.calls.every((call) => call[1][0] === "find-generic-password")).toBe(true);
  });

  it("does not fall back to Keychain when the authoritative file is temporarily unreadable", () => {
    seedAccounts();
    fs.writeFileSync(credentialFile, "{synthetic incomplete credentials");
    const beforeConfig = fs.readFileSync(config, "utf8");
    security.mockClear();
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "unreadable-source" });
    expect(fs.readFileSync(credentialFile, "utf8")).toBe("{synthetic incomplete credentials");
    expect(fs.readFileSync(config, "utf8")).toBe(beforeConfig);
    expect(keychainRaw).toBe(tokens("bob"));
    expect(security).not.toHaveBeenCalled();
  });

  it("checks the recovery baseline independently before writing live files", () => {
    seedAccounts(); readCredentials(); denyRead = true;
    const beforeConfig = fs.readFileSync(config, "utf8");
    const result = withLocks([...CREDENTIAL_LOCKS, CONFIG_LOCK], () =>
      writeLiveAccount(snapshot("account-1").claudeJsonRaw, tokens("alice")));
    expect(result).toMatchObject({ ok: true, value: { ok: false, error: "copy-failed" } });
    expect(fs.readFileSync(config, "utf8")).toBe(beforeConfig);
    expect(keychainRaw).toBe(tokens("bob"));
    expect(hasPendingSwitch()).toBe(false);
  });
});

describe("fresh recovery verification", () => {
  it("rejects a different live login even when the prior cached login matches the journal", () => {
    leaveCommittedJournal(); readCredentials();
    keychainRaw = tokens("charlie");
    const beforeConfig = fs.readFileSync(config, "utf8");
    expect(recoverPendingSwitch()).toMatchObject({ ok: false, error: "recovery-required" });
    expect(keychainRaw).toBe(tokens("charlie"));
    expect(fs.readFileSync(config, "utf8")).toBe(beforeConfig);
    expect(hasPendingSwitch()).toBe(true);
  });

  it("preserves a pending journal on denied reads and recovers immediately after unlocking", () => {
    leaveCommittedJournal(); readCredentials(); denyRead = true;
    const beforeJournal = fs.readFileSync(journal, "utf8");
    const beforeConfig = fs.readFileSync(config, "utf8");
    expect(recoverPendingSwitch()).toMatchObject({ ok: false, error: "recovery-required" });
    expect(fs.readFileSync(journal, "utf8")).toBe(beforeJournal);
    expect(fs.readFileSync(config, "utf8")).toBe(beforeConfig);
    expect(keychainRaw).toBe(tokens("alice"));
    denyRead = false;
    expect(recoverPendingSwitch()).toEqual({ ok: true });
    expect(hasPendingSwitch()).toBe(false);
    expect(keychainRaw).toBe(tokens("alice"));
  });
});

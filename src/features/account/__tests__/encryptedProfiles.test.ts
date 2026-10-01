import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const fixture = vi.hoisted(() => {
  const f = require("fs") as typeof import("fs");
  const p = require("path") as typeof import("path");
  const o = require("os") as typeof import("os");
  const home = f.mkdtempSync(p.join(o.tmpdir(), "manager-encrypted-profiles-"));
  return { home, claude: p.join(home, ".claude"), vault: p.join(home, "vault") };
});
vi.mock("os", async (importOriginal) => ({ ...(await importOriginal<typeof import("os")>()), homedir: () => fixture.home }));
vi.mock("../../../core/config", () => ({ CLAUDE_DIR: fixture.claude }));
import { closeProfileVault, initializeProfileVault, readProfileFile } from "../profileVault";
import { getActiveProfileSlug, listProfiles, removeProfile, saveProfile, switchProfile } from "../profiles";

import { readAccountSnapshot, SNAPSHOT_FILE } from "../accountSnapshot";

let secrets: Map<string, string>;
const storage = { get: async (name: string) => secrets.get(name), store: async (name: string, raw: string) => { secrets.set(name, raw); } };
const liveConfig = path.join(fixture.home, ".claude.json");
const liveCredentials = path.join(fixture.claude, ".credentials.json");
function login(account: string) {
  fs.writeFileSync(liveConfig, JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: `${account}@example.test` }, userID: "same-device", projects: { "keep-project": {} } }));
  fs.writeFileSync(liveCredentials, JSON.stringify({ claudeAiOauth: { accessToken: `synthetic-access-${account}`, refreshToken: `synthetic-refresh-${account}`, expiresAt: Date.now() + 3_600_000, subscriptionType: "max" } }));
}
beforeEach(async () => {
  fs.mkdirSync(fixture.claude, { recursive: true });
  secrets = new Map();
  await initializeProfileVault(storage, fixture.vault);
});
afterEach(() => {
  vi.restoreAllMocks();
  closeProfileVault();
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

describe("two accounts using the real encrypted vault", () => {
  it("saves two accounts encrypted and switches back without replacing project configuration", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    login("bob"); expect(saveProfile("Account 2").ok).toBe(true);
    expect(listProfiles().map(p => p.label)).toEqual(["Account 1", "Account 2"]);
    expect(getActiveProfileSlug()).toBe("account-2");
    expect(switchProfile("account-1").ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(liveCredentials, "utf8")).claudeAiOauth.accessToken).toBe("synthetic-access-alice");
    expect(JSON.parse(fs.readFileSync(liveConfig, "utf8")).projects).toEqual({ "keep-project": {} });
    expect(getActiveProfileSlug()).toBe("account-1");
    for (const slot of ["account-1", "account-2"]) {
      for (const file of fs.readdirSync(path.join(fixture.vault, slot))) {
        const disk = fs.readFileSync(path.join(fixture.vault, slot, file), "utf8");
        expect(disk).not.toContain("synthetic-access-");
        expect(disk).not.toContain("synthetic-refresh-");
      }
    }
    expect(readAccountSnapshot(path.join(fixture.vault, "account-2")).credsRaw).toContain("synthetic-access-bob");
  });
  it("does not change the live login if the target encrypted snapshot is corrupted", () => {
    login("alice"); saveProfile("Account 1");
    login("bob"); saveProfile("Account 2");
    fs.writeFileSync(path.join(fixture.vault, "account-1", SNAPSHOT_FILE), "broken snapshot");
    const before = fs.readFileSync(liveCredentials, "utf8");
    const identity = fs.readFileSync(liveConfig, "utf8");
    expect(switchProfile("account-1").ok).toBe(false);
    expect(fs.readFileSync(liveCredentials, "utf8")).toBe(before);
    expect(fs.readFileSync(liveConfig, "utf8")).toBe(identity);
  });
  it("refreshes outgoing credentials before switching to the other saved account", () => {
    login("alice"); saveProfile("Account 1");
    login("bob"); saveProfile("Account 2");
    const credentials = JSON.parse(fs.readFileSync(liveCredentials, "utf8"));
    credentials.claudeAiOauth.refreshToken = "synthetic-rotated-refresh-bob";
    fs.writeFileSync(liveCredentials, JSON.stringify(credentials));
    expect(switchProfile("account-1").ok).toBe(true);
    expect(switchProfile("account-2").ok).toBe(true);
    expect(fs.readFileSync(liveCredentials, "utf8")).toContain("synthetic-rotated-refresh-bob");
  });
  it("rejects traversal when deleting a saved profile", () => {
    login("alice"); saveProfile("Account 1");
    expect(() => removeProfile("../.claude")).toThrow("Invalid account profile identifier");
    expect(fs.existsSync(liveCredentials)).toBe(true);
  });
  it("refuses switching while Claude's credential refresh lock is held", () => {
    login("alice"); saveProfile("Account 1");
    login("bob"); saveProfile("Account 2");
    const before = fs.readFileSync(liveCredentials, "utf8");
    const lock = path.join(fixture.claude, ".oauth_refresh.lock");
    fs.mkdirSync(lock);
    let time = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => { time += 500; return time; });
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const result = switchProfile("account-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("refreshing its credentials");
    expect(fs.readFileSync(liveCredentials, "utf8")).toBe(before);
    expect(fs.existsSync(lock)).toBe(true);
  });
});

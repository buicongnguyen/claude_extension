import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ active: "saved" as string | null, hash: "saved-hash" as string | undefined, uuid: "alice" }));
vi.mock("../profiles", () => ({
  readProfileListing: () => ({ profiles: [{ slug: "saved", credentialsHash: "saved-hash", accountUuid: "alice", email: "alice@example.test" }], issues: [] }),
  getActiveProfileSlug: () => state.active,
}));
vi.mock("../credentials", () => ({ readCredentials: () => state.hash ? { hash: state.hash, blob: { claudeAiOauth: {} }, source: { kind: "file" } } : null }));
vi.mock("../models", () => ({ discoverModelsFromCli: () => [] }));
vi.mock("../claudeJsonCache", () => ({ readClaudeJsonParsed: () => ({ oauthAccount: { accountUuid: state.uuid, emailAddress: state.uuid + "@example.test", displayName: state.uuid }, userID: "device" }) }));
import { setAccountFocusedMode } from "../../../core/workloadPolicy";
import { parseAccountData } from "../parser";
beforeEach(() => { state.active = "saved"; state.hash = "saved-hash"; state.uuid = "alice"; setAccountFocusedMode(true); });
afterEach(() => setAccountFocusedMode(false));
describe("snapshot warning in account data", () => {
  it("warns only when a saved active login differs", () => {
    expect(parseAccountData().profileSnapshotChanged).toBe(false);
    state.hash = "rotated-hash";
    expect(parseAccountData().profileSnapshotChanged).toBe(true);
    state.active = null;
    expect(parseAccountData().profileSnapshotChanged).toBe(false);
  });
  it("does not mistake a missing login for a new token to save", () => {
    state.hash = undefined;
    const data = parseAccountData();
    expect(data.profileSnapshotChanged).toBe(false);
    expect(data.profile.signedIn).toBe(false);
  });
});

it("does not expose the stale identity as the signed-in account", () => {
  state.uuid = "bob";
  const data = parseAccountData();
  expect(data.profileIdentityMismatch).toBe(true);
  expect(data.activeProfileSlug).toBe("saved");
  expect(data.profile.email).toBe("");
  expect(data.profile.accountUuid).toBe("");
  expect(data.profile.displayName).toBe("Account identity needs verification");
  expect(data.savedProfiles[0].email).toBe("alice@example.test");
});
it("retains a consistent live identity", () => {
  const data = parseAccountData();
  expect(data.profileIdentityMismatch).toBe(false);
  expect(data.profile.email).toBe("alice@example.test");
});

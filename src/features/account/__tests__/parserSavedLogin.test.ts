import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ active: "saved" as string | null, hash: "saved-hash" as string | undefined }));
vi.mock("../profiles", () => ({
  readProfileListing: () => ({ profiles: [{ slug: "saved", credentialsHash: "saved-hash" }], issues: [] }),
  getActiveProfileSlug: () => state.active,
}));
vi.mock("../credentials", () => ({ readCredentials: () => state.hash ? { hash: state.hash, blob: { claudeAiOauth: {} }, source: { kind: "file" } } : null }));
vi.mock("../models", () => ({ discoverModelsFromCli: () => [] }));
import { setAccountFocusedMode } from "../../../core/workloadPolicy";
import { parseAccountData } from "../parser";
beforeEach(() => { state.active = "saved"; state.hash = "saved-hash"; setAccountFocusedMode(true); });
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

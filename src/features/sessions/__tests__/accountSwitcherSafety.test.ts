import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  current: {} as any, picker: undefined as any, accept: undefined as (() => Promise<void>) | undefined,
  update: vi.fn(), switch: vi.fn(), saveNew: vi.fn(), warning: vi.fn(), launch: vi.fn(), error: vi.fn(), events: [] as string[],
}));
vi.mock("vscode", () => ({
  ThemeIcon: class { constructor(public id: string) {} },
  QuickPickItemKind: { Separator: -1 },
  window: {
    createQuickPick: () => (state.picker = {
      items: [], selectedItems: [], hide: vi.fn(), dispose: vi.fn(), show: vi.fn(),
      onDidTriggerItemButton: vi.fn(), onDidHide: vi.fn(),
      onDidAccept: (handler: () => Promise<void>) => { state.accept = handler; },
    }),
    showErrorMessage: state.error, showInformationMessage: vi.fn(), showWarningMessage: state.warning,
  },
  commands: { executeCommand: vi.fn() },
}));
vi.mock("../../account/parser", () => ({ parseAccountData: () => state.current }));
vi.mock("../../account/profiles", () => ({ removeProfile: vi.fn() }));
vi.mock("../profileActions", () => ({ updateProfileWithConfirmation: state.update, switchProfileWithConfirmation: state.switch }));
vi.mock("../accountHandlers", () => ({ promptToSaveProfile: state.saveNew }));
vi.mock("../accountPush", () => ({ postAccountData: vi.fn() }));
vi.mock("../../../extension/workspace", () => ({ getWorkspace: () => undefined }));
vi.mock("../../../extension/terminal", () => ({ createTerminal: vi.fn(), launchClaudeWithInput: state.launch }));

import { openAccountSwitcher } from "../accountSwitcher";

function current(slug: string) {
  return { profile: { signedIn: true, email: `${slug}@example.test` }, activeProfileSlug: slug,
    savedProfiles: [{ slug, label: slug, email: `${slug}@example.test`, accountUuid: slug, credentialsHash: slug, savedAt: "", userID: "device", subscriptionType: "", organizationName: "" }] };
}
async function chooseLogin() {
  state.picker.selectedItems = [state.picker.items.find((item: any) => item.action === "login")];
  await state.accept!();
}
beforeEach(() => {
  vi.clearAllMocks(); state.current = current("alice"); state.events = [];
  state.update.mockImplementation(async () => { state.events.push("save"); return { ok: true, data: {} }; });
  state.launch.mockImplementation(() => { state.events.push("login"); });
  state.switch.mockResolvedValue({ ok: true, data: { label: "alice" } });
  state.saveNew.mockResolvedValue(true);
  state.warning.mockResolvedValue(undefined);
});
describe("login transition from the account picker", () => {
  it("preserves the outgoing snapshot before opening Claude login", async () => {
    await openAccountSwitcher({ getWebview: () => undefined, dispatch: vi.fn() });
    await chooseLogin();
    expect(state.update).toHaveBeenCalledWith("alice");
    expect(state.events).toEqual(["save", "login"]);
  });
  it("does not open login if snapshot confirmation is cancelled or fails", async () => {
    state.update.mockResolvedValue({ ok: false, error: "identity-unverified", detail: "Cancelled" });
    await openAccountSwitcher({ getWebview: () => undefined, dispatch: vi.fn() });
    await chooseLogin();
    expect(state.launch).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalled();
  });
  it("rechecks the current account after another window changes it", async () => {
    await openAccountSwitcher({ getWebview: () => undefined, dispatch: vi.fn() });
    state.current = current("bob");
    await chooseLogin();
    expect(state.update).toHaveBeenCalledWith("bob");
    expect(state.update).not.toHaveBeenCalledWith("alice");
  });
});

async function choose(action: string, slug?: string) {
  state.picker.selectedItems = [state.picker.items.find((item: any) => item.action === action && (!slug || item.slug === slug))];
  await state.accept!();
}

describe("saved account preservation from the picker", () => {
  function unsavedBob() {
    state.current = { ...current("alice"), activeProfileSlug: null, profile: { signedIn: true, email: "bob@example.test" } };
  }
  it("saves the unsaved outgoing login before retrying a switch", async () => {
    unsavedBob();
    state.warning.mockResolvedValueOnce("Switch").mockResolvedValueOnce("Save and switch");
    state.switch.mockReset().mockImplementationOnce(async () => { state.events.push("guard"); return { ok: false, error: "unsaved-active-account" }; })
      .mockImplementationOnce(async () => { state.events.push("switch"); return { ok: true, data: { label: "alice" } }; });
    state.saveNew.mockImplementation(async () => { state.events.push("save-new"); return true; });
    await openAccountSwitcher({ getWebview: () => undefined, dispatch: vi.fn() });
    await choose("switch", "alice");
    expect(state.events).toEqual(["guard", "save-new", "switch"]);
    expect(state.switch).toHaveBeenCalledTimes(2);
  });
  it("keeps the current login when save-first confirmation is cancelled", async () => {
    unsavedBob();
    state.switch.mockResolvedValue({ ok: false, error: "unsaved-active-account" });
    state.warning.mockResolvedValueOnce("Switch").mockResolvedValueOnce(undefined);
    await openAccountSwitcher({ getWebview: () => undefined, dispatch: vi.fn() });
    await choose("switch", "alice");
    expect(state.saveNew).not.toHaveBeenCalled();
    expect(state.switch).toHaveBeenCalledTimes(1);
  });
  it("does not retry after the save input is cancelled or saving fails", async () => {
    unsavedBob();
    state.switch.mockResolvedValue({ ok: false, error: "unsaved-active-account" });
    state.warning.mockResolvedValueOnce("Switch").mockResolvedValueOnce("Save and switch");
    state.saveNew.mockResolvedValue(false);
    await openAccountSwitcher({ getWebview: () => undefined, dispatch: vi.fn() });
    await choose("switch", "alice");
    expect(state.switch).toHaveBeenCalledTimes(1);
    expect(state.error).not.toHaveBeenCalled();
  });
  it("checks the selected account even when it was active when the picker opened", async () => {
    await openAccountSwitcher({ getWebview: () => undefined, dispatch: vi.fn() });
    unsavedBob();
    state.warning.mockResolvedValueOnce("Switch");
    await choose("switch", "alice");
    expect(state.switch).toHaveBeenCalledWith("alice");
  });
  it("runs native Save without an open Manager webview", async () => {
    unsavedBob();
    const dispatch = vi.fn();
    await openAccountSwitcher({ getWebview: () => undefined, dispatch });
    await choose("save");
    expect(state.saveNew).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("shows unreadable saved slots without restoring or deleting them", async () => {
    state.current.profileStorageIssues = [{ slug: "old-account", code: "profile-unreadable", detail: "The saved account remains stored but cannot be read." }];
    await openAccountSwitcher({ getWebview: () => undefined, dispatch: vi.fn() });
    expect(state.picker.items.some((item: any) => item.label === "old-account")).toBe(true);
    await choose("unreadable");
    expect(state.error).toHaveBeenCalledWith("The saved account remains stored but cannot be read.");
    expect(state.switch).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });
});

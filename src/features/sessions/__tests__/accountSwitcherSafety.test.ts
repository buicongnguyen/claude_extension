import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  current: {} as any, picker: undefined as any, accept: undefined as (() => Promise<void>) | undefined,
  update: vi.fn(), switch: vi.fn(), saveNew: vi.fn(), warning: vi.fn(), launch: vi.fn(), error: vi.fn(), events: [] as string[],
  audit: [] as Array<{ event: string; fields?: any }>, info: vi.fn(), command: vi.fn(), push: vi.fn(),
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
    showErrorMessage: state.error, showInformationMessage: state.info, showWarningMessage: state.warning,
  },
  commands: { executeCommand: state.command },
}));
vi.mock("../../account/parser", () => ({ parseAccountData: () => state.current }));
vi.mock("../../account/profiles", () => ({ removeProfile: vi.fn() }));
vi.mock("../profileActions", () => ({ updateProfileWithConfirmation: state.update, switchProfileWithConfirmation: state.switch }));
vi.mock("../accountHandlers", () => ({ promptToSaveProfile: state.saveNew }));
vi.mock("../accountPush", () => ({ postAccountData: state.push }));
vi.mock("../../../extension/workspace", () => ({ getWorkspace: () => undefined }));
vi.mock("../../../extension/terminal", () => ({ createTerminal: vi.fn(), launchClaudeWithInput: state.launch }));

vi.mock("../../account/accountAudit", () => ({
  withAccountAudit: (_action: string, work: () => unknown) => { state.audit.push({ event: "operation_started" }); return work(); },
  auditAccountEvent: (event: string, fields?: any) => { state.audit.push({ event, fields }); },
  safeAccountErrorCode: (error: any) => typeof error === "string" ? error : error?.code === "EACCES" ? "EACCES" : "unknown",
}));

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
  vi.clearAllMocks(); state.current = current("alice"); state.events = []; state.audit = [];
  state.error.mockReset(); state.info.mockReset(); state.command.mockReset(); state.push.mockReset();
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


describe("saved switch diagnostics", () => {
  const ctx = { getWebview: () => undefined, dispatch: vi.fn() };
  it("records cancellation without starting a switch", async () => {
    await openAccountSwitcher(ctx);
    await choose("switch", "alice");
    expect(state.switch).not.toHaveBeenCalled();
    expect(state.audit.at(-1)).toMatchObject({ event: "operation_cancelled", fields: { stage: "confirmation", reason: "user_cancelled" } });
  });
  it("records verified local completion before the reload prompt resolves", async () => {
    state.warning.mockResolvedValue("Switch");
    let finish!: (choice: string | undefined) => void;
    state.info.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await openAccountSwitcher(ctx);
    state.picker.selectedItems = [state.picker.items.find((item: any) => item.slug === "alice")];
    const pending = state.accept!();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(state.audit.at(-1)).toMatchObject({ event: "operation_completed", fields: { reason: "local_operation_succeeded" } });
    finish("Reload window");
    state.command.mockImplementation(async () => {
      expect(state.audit.at(-1)).toMatchObject({ event: "reload_requested" });
    });
    await pending;
    expect(state.command).toHaveBeenCalledWith("workbench.action.reloadWindow");
  });
  it("keeps committed success when reload fails", async () => {
    state.warning.mockResolvedValue("Switch"); state.info.mockResolvedValue("Reload window");
    state.command.mockRejectedValue(Object.assign(new Error("private path/token"), { code: "EACCES" }));
    await openAccountSwitcher(ctx); await choose("switch", "alice");
    expect(state.audit).toContainEqual(expect.objectContaining({ event: "operation_completed" }));
    expect(state.audit.at(-1)).toMatchObject({ event: "reload_failed", fields: { code: "EACCES" } });
    expect(state.audit.some((e) => e.event === "operation_failed")).toBe(false);
    expect(JSON.stringify(state.audit)).not.toMatch(/private|alice|example/);
  });
  it("contains unexpected rejections when VS Code fires a void event", async () => {
    state.warning.mockResolvedValue("Switch");
    state.switch.mockRejectedValue(new Error("secret account data"));
    state.error.mockRejectedValue(new Error("notification host closing"));
    await openAccountSwitcher(ctx);
    state.picker.selectedItems = [state.picker.items.find((item: any) => item.slug === "alice")];
    // VS Code ignores this promise; vitest would fail an unhandled rejection.
    void state.accept!();
    await vi.waitFor(() => expect(state.error).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.audit.at(-1)).toMatchObject({ event: "operation_failed", fields: { stage: "switch", code: "unknown" } });
    expect(JSON.stringify(state.audit)).not.toContain("secret");
  });
  it("records refresh failure separately after a completed switch", async () => {
    state.warning.mockResolvedValue("Switch"); state.push.mockImplementation(() => { throw new Error("private"); });
    await openAccountSwitcher({ ...ctx, getWebview: () => ({} as any) });
    await choose("switch", "alice");
    expect(state.audit.at(-1)).toMatchObject({ event: "ui_failed", fields: { stage: "refresh_ui" } });
    expect(state.audit.filter((e) => e.event === "operation_completed")).toHaveLength(1);
    expect(state.audit.some((e) => e.event === "operation_failed")).toBe(false);
  });
  it("records a refused switch code without its account details", async () => {
    state.warning.mockResolvedValue("Switch");
    state.switch.mockResolvedValue({ ok: false, error: "recovery-required", detail: "private@example.test" });
    await openAccountSwitcher(ctx); await choose("switch", "alice");
    expect(state.audit.at(-1)).toMatchObject({ event: "operation_failed", fields: { code: "recovery-required" } });
    expect(JSON.stringify(state.audit)).not.toContain("private@example.test");
  });
  it("distinguishes a save-first failure from cancellation", async () => {
    state.warning.mockResolvedValueOnce("Switch").mockResolvedValueOnce("Save and switch");
    state.switch.mockResolvedValue({ ok: false, error: "unsaved-active-account" });
    state.saveNew.mockImplementation(async (_ctx: unknown, onFailure: (code: string) => void) => { onFailure("copy-failed"); return false; });
    await openAccountSwitcher(ctx); await choose("switch", "alice");
    expect(state.audit.at(-1)).toMatchObject({ event: "operation_failed", fields: { stage: "save_current", code: "copy-failed" } });
    expect(state.audit.some((e) => e.event === "operation_cancelled")).toBe(false);
  });
  it("treats explicit identity-confirmation cancellation as cancellation", async () => {
    state.warning.mockResolvedValue("Switch");
    state.switch.mockResolvedValue({ ok: false, error: "identity-unverified", cancelled: true });
    await openAccountSwitcher(ctx); await choose("switch", "alice");
    expect(state.audit.at(-1)).toMatchObject({ event: "operation_cancelled", fields: { code: "identity-unverified" } });
    expect(state.error).not.toHaveBeenCalled();
  });
});

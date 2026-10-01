import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  current: {} as any, picker: undefined as any, accept: undefined as (() => Promise<void>) | undefined,
  update: vi.fn(), launch: vi.fn(), error: vi.fn(), events: [] as string[],
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
    showErrorMessage: state.error, showInformationMessage: vi.fn(), showWarningMessage: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
}));
vi.mock("../../account/parser", () => ({ parseAccountData: () => state.current }));
vi.mock("../../account/profiles", () => ({ removeProfile: vi.fn() }));
vi.mock("../profileActions", () => ({ updateProfileWithConfirmation: state.update, switchProfileWithConfirmation: vi.fn() }));
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

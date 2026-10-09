import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ action: vi.fn(), warning: vi.fn(), audit: vi.fn(), approval: { synthetic: true } }));
vi.mock("vscode", () => ({ window: { showWarningMessage: state.warning } }));
vi.mock("../../account/accountAudit", () => ({ auditAccountEvent: state.audit }));
vi.mock("../../account/profiles", () => ({
  switchProfile: state.action, updateProfile: state.action, getActiveProfileSlug: () => "synthetic-private-slot",
  captureProfileUpdate: () => ({ ok: true, data: state.approval }), listProfiles: () => [],
}));
import { switchProfileWithConfirmation } from "../profileActions";
beforeEach(() => { vi.resetAllMocks(); state.action.mockReturnValue({ ok: false, error: "identity-unverified" }); });
describe("identity confirmation audit", () => {
  it("marks explicit cancellation without retrying the transaction", async () => {
    const result = await switchProfileWithConfirmation("target");
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(state.action).toHaveBeenCalledTimes(1);
    expect(state.audit.mock.calls.map((c) => c[0])).toEqual(["identity_confirmation_requested", "identity_confirmation_cancelled"]);
    expect(JSON.stringify(state.audit.mock.calls)).not.toContain("synthetic-private-slot");
  });
  it("records acceptance then retries with the captured approval", async () => {
    state.warning.mockResolvedValue("Confirm same account");
    state.action.mockReturnValueOnce({ ok: false, error: "identity-unverified" }).mockReturnValueOnce({ ok: true, data: {} });
    expect(await switchProfileWithConfirmation("target")).toEqual({ ok: true, data: {} });
    expect(state.action).toHaveBeenLastCalledWith("target", state.approval);
    expect(state.audit.mock.calls.map((c) => c[0])).toEqual(["identity_confirmation_requested", "identity_confirmation_accepted"]);
  });
});

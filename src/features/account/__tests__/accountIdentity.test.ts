import { describe, expect, it } from "vitest";
import { savedIdentityConflicts } from "../accountIdentity";
const saved = { accountUuid: "alice", email: "alice@example.test", credentialsHash: "exact" };
describe("local saved-account identity conflict", () => {
  it("requires an exact credential match before diagnosing a conflict", () => {
    const other = { accountUuid: "bob", email: "bob@example.test" };
    expect(savedIdentityConflicts(other, saved, "exact")).toBe(true);
    expect(savedIdentityConflicts(other, saved, "rotated")).toBe(false);
    expect(savedIdentityConflicts(other, saved, undefined)).toBe(false);
    expect(savedIdentityConflicts(other, undefined, "exact")).toBe(false);
  });
  it("allows an email rename for the same account UUID", () => {
    expect(savedIdentityConflicts({ accountUuid: "alice", email: "renamed@example.test" }, saved, "exact")).toBe(false);
    expect(savedIdentityConflicts({ accountUuid: "bob", email: saved.email }, saved, "exact")).toBe(true);
  });
  it("uses email only when UUID comparison is unavailable", () => {
    expect(savedIdentityConflicts({ accountUuid: "", email: "ALICE@EXAMPLE.TEST" }, saved, "exact")).toBe(false);
    expect(savedIdentityConflicts({ accountUuid: "", email: "bob@example.test" }, saved, "exact")).toBe(true);
    expect(savedIdentityConflicts({ accountUuid: "", email: "" }, saved, "exact")).toBe(false);
  });
});

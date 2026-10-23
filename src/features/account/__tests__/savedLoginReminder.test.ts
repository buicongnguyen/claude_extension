import { describe, expect, it } from "vitest";
import { savedLoginReminder } from "../savedLoginReminder";
const NOW = Date.parse("2026-10-23T12:00:00Z");
describe("saved login reminder", () => {
  it("starts at six hours, not before", () => {
    expect(savedLoginReminder(new Date(NOW - 6 * 3600_000 + 1).toISOString(), false, NOW)).toBe("");
    expect(savedLoginReminder(new Date(NOW - 6 * 3600_000).toISOString(), false, NOW)).toContain("6h+");
  });
  it("does not infer expiration from active, missing, invalid, or future timestamps", () => {
    expect(savedLoginReminder("2026-10-20T12:00:00Z", true, NOW)).toBe("");
    for (const value of ["", "invalid", "2026-10-24T12:00:00Z"]) expect(savedLoginReminder(value, false, NOW)).toBe("");
  });
});

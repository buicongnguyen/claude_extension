import { describe, expect, it } from "vitest";
import { savedLoginReminder, formatSavedLoginTime } from "../savedLoginReminder";
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

describe("saved login time", () => {
  it("includes an absolute date and the elapsed hours/minutes", () => {
    const text = formatSavedLoginTime("2026-10-23T05:45:00Z", NOW);
    expect(text).toContain("Last saved:");
    expect(text).toContain("2026");
    expect(text).toContain("(6h 15m ago)");
  });
  it("distinguishes new snapshots from old ones", () => {
    expect(formatSavedLoginTime(new Date(NOW).toISOString(), NOW)).toContain("(just now)");
    expect(formatSavedLoginTime(new Date(NOW - 60_000).toISOString(), NOW)).toContain("(1m ago)");
    expect(formatSavedLoginTime(new Date(NOW - 49 * 3600_000).toISOString(), NOW)).toContain("(2d 1h ago)");
  });
  it("reports unknown and future timestamps without inventing a login age", () => {
    for (const input of ["", "invalid"]) expect(formatSavedLoginTime(input, NOW)).toBe("Last saved: unknown");
    expect(formatSavedLoginTime(new Date(NOW + 60_000).toISOString(), NOW)).toContain("ahead of this computer's clock");
  });
});

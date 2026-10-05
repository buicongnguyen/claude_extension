// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "preact";
import { act, fireEvent, render } from "@testing-library/preact";
import type { Message, SessionDetail, WorktreeRef } from "../../../types";
import { DetailView } from "./DetailView";
import {
  currentProjectSignal,
  detailLoadingSignal,
  detailSignal,
  worktreesSignal,
  _resetSessionsSignals,
} from "../../model";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("../../../../../webview/shared/hooks", async (importActual) => ({
  ...(await importActual<typeof import("../../../../../webview/shared/hooks")>()),
  useApi: () => ({ post }),
  setVscodeApi: () => {},
}));

function ref(over: Partial<WorktreeRef> = {}): WorktreeRef {
  return {
    path: "/repo/.claude/worktrees/feat",
    branch: "worktree-feat",
    kind: "claude",
    exists: true,
    locked: false,
    repoRoot: "/repo",
    ...over,
  };
}

function msg(over: Partial<Message>): Message {
  return { role: "user", content: "c", timestamp: "", ...over };
}

function detail(over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "a",
    name: "My session",
    project: "proj",
    projectPath: "/p",
    branch: "main",
    entrypoint: "cli",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_300_000,
    messageCount: 2,
    summary: "the summary",
    prompts: [],
    projectKey: "proj",
    searchHaystack: "",
    messages: [msg({ content: "first" }), msg({ role: "assistant", content: "second" })],
    totalMessages: 2,
    detailMode: "last",
    ...over,
  };
}

describe("DetailView", () => {
  beforeEach(() => {
    _resetSessionsSignals();
    post.mockClear();
  });

  it("renders a loading shell while loading", () => {
    detailLoadingSignal.value = true;
    detailSignal.value = null;
    const { container } = render(h(DetailView, {}));
    // The bare "Loading…" text was replaced by the content-shaped detail skeleton.
    expect(container.querySelector(".skeleton-detail")).toBeTruthy();
  });

  it("renders the title, project and messages", () => {
    currentProjectSignal.value = "proj";
    detailSignal.value = detail();
    const { container, getByText } = render(h(DetailView, {}));
    expect(container.querySelector(".d-title")?.textContent).toBe("My session");
    expect(getByText("Messages (2)")).toBeTruthy();
    expect(container.querySelectorAll(".d-msg").length).toBe(2);
  });

  it("renders newest-first in last mode", () => {
    currentProjectSignal.value = "proj";
    detailSignal.value = detail({ detailMode: "last" });
    const { container } = render(h(DetailView, {}));
    const contents = [...container.querySelectorAll(".d-msg-content")].map((e) => e.textContent);
    // last mode reverses → assistant "second" first.
    expect(contents[0]).toBe("second");
  });

  it("renders every match while searching — no 'Show more' truncation of the match set", async () => {
    vi.useFakeTimers();
    try {
      currentProjectSignal.value = "proj";
      // 210 messages > MESSAGE_WINDOW (200). In the paged view this truncates
      // behind "Show more"; while searching, all matches must render.
      const many = Array.from({ length: 210 }, (_, i) =>
        msg({ content: `match ${i} widget` }),
      );
      detailSignal.value = detail({
        messages: many,
        totalMessages: 210,
        detailQuery: "widget",
        totalMatches: 210,
      });
      const { container } = render(h(DetailView, {}));

      const input = container.querySelector(".d-msg-search .tf-input") as HTMLInputElement;
      fireEvent.input(input, { target: { value: "widget" } });
      // Flush the 250ms search debounce so debouncedQuery → "widget" and the
      // view enters search mode (renders all matches, no windowing).
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(container.querySelector(".show-more-row")).toBeNull();
      expect(container.querySelectorAll(".d-msg").length).toBe(210);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the cross-project notice when the session is from another project", () => {
    currentProjectSignal.value = "other";
    detailSignal.value = detail({ project: "proj", projectKey: "proj" });
    const { container, getByText } = render(h(DetailView, {}));
    expect(container.querySelector(".d-notice")).toBeTruthy();
    expect(getByText(/Open .* to resume/)).toBeTruthy();
  });

  it("offers separate open and continue actions for a same-project session", () => {
    currentProjectSignal.value = "proj";
    detailSignal.value = detail();
    const { getByText } = render(h(DetailView, {}));
    expect(getByText("Open conversation")).toBeTruthy();
    expect(getByText("Continue task")).toBeTruthy();
  });

  it("shows the latest/earliest toggle (shared Segmented) only for long transcripts", () => {
    currentProjectSignal.value = "proj";
    detailSignal.value = detail({ totalMessages: 200 });
    const { container, getByText } = render(h(DetailView, {}));
    // Migrated from the legacy .vs-segmented pill to the shared <Segmented>
    // (native .vsc-segmented track look), so the selected-state matches every
    // other segmented control in the app.
    expect(container.querySelector(".vsc-segmented")).toBeTruthy();
    expect(getByText("Latest")).toBeTruthy();
    expect(getByText("Earliest")).toBeTruthy();
  });

  it("hides the toggle for short transcripts", () => {
    currentProjectSignal.value = "proj";
    detailSignal.value = detail({ totalMessages: 2 });
    const { container } = render(h(DetailView, {}));
    expect(container.querySelector(".vsc-segmented")).toBeNull();
  });

  describe("worktree", () => {
    it("renders the worktree info row (kind, path, branch, repo) for a claude worktree", () => {
      currentProjectSignal.value = "proj";
      worktreesSignal.value = { a: ref() };
      detailSignal.value = detail();
      const { container } = render(h(DetailView, {}));
      const block = container.querySelector(".d-worktree");
      expect(block).toBeTruthy();
      expect(block?.textContent).toContain("Claude-created worktree");
      const values = [...container.querySelectorAll(".d-worktree__v")].map((e) => e.textContent);
      expect(values).toContain("/repo/.claude/worktrees/feat");
      expect(values).toContain("worktree-feat");
      expect(values).toContain("/repo");
    });

    it("omits the info row for a main-checkout ref", () => {
      currentProjectSignal.value = "proj";
      worktreesSignal.value = { a: ref({ kind: "main" }) };
      detailSignal.value = detail();
      const { container } = render(h(DetailView, {}));
      expect(container.querySelector(".d-worktree")).toBeNull();
    });

    it("opens the conversation in an existing worktree and offers task continuation", () => {
      currentProjectSignal.value = "proj";
      worktreesSignal.value = { a: ref() };
      detailSignal.value = detail();
      const { getByText } = render(h(DetailView, {}));
      expect(getByText("Open conversation").getAttribute("title")).toBe("Open conversation in worktree feat");
      expect(getByText("Continue task")).toBeTruthy();
    });

    it("offers Recreate worktree and fires createWorktree for a removed claude worktree", () => {
      currentProjectSignal.value = "proj";
      worktreesSignal.value = { a: ref({ exists: false, kind: "claude" }) };
      detailSignal.value = detail();
      const { getByText, queryByText } = render(h(DetailView, {}));
      // Both continuation actions are unavailable when the checkout is gone.
      expect(queryByText("Open conversation")).toBeNull();
      expect(queryByText("Continue task")).toBeNull();
      const btn = getByText("Recreate worktree");
      fireEvent.click(btn);
      expect(post).toHaveBeenCalledWith({ type: "createWorktree", sessionId: "a" });
    });

    it("explains a removed user worktree without offering recreate", () => {
      currentProjectSignal.value = "proj";
      worktreesSignal.value = { a: ref({ exists: false, kind: "user" }) };
      detailSignal.value = detail();
      const { container, queryByText } = render(h(DetailView, {}));
      expect(queryByText("Recreate worktree")).toBeNull();
      expect(container.querySelector(".d-notice")?.textContent).toContain("removed from disk");
    });
  });

  // The header's second line repeats the first when a session is named after
  // its own opening prompt — the same defect the list row had, in the other
  // component that renders the pair.
  it("omits the summary line when it repeats the title", () => {
    detailSignal.value = detail({ name: "Fix the parser", summary: "Fix the parser" });
    const { container } = render(h(DetailView, {}));
    expect(container.querySelector(".d-title")?.textContent).toBe("Fix the parser");
    expect(container.querySelector(".d-subtitle")).toBeNull();
  });

  it("keeps the summary line when it adds something", () => {
    detailSignal.value = detail({
      name: "Fix the parser",
      summary: "trailing comma in settings.json",
    });
    const { container } = render(h(DetailView, {}));
    expect(container.querySelector(".d-subtitle")?.textContent).toBe(
      "trailing comma in settings.json",
    );
  });
});

it("offers fresh recovery even while the exhausted official chat is live", () => {
  _resetSessionsSignals(); post.mockClear();
  currentProjectSignal.value = "proj";
  detailSignal.value = detail({ entrypoint: "claude-vscode", isLive: true });
  const { getByRole } = render(h(DetailView, {}));
  expect(getByRole("button", { name: "View" })).toBeTruthy();
  fireEvent.click(getByRole("button", { name: "Resume after account switch" }));
  expect(post).toHaveBeenCalledWith({ type: "resumeSession", sessionId: "a", fresh: true });
});

describe("DetailView — continue task after usage reset", () => {
  beforeEach(() => {
    _resetSessionsSignals();
    post.mockClear();
    currentProjectSignal.value = "proj";
  });

  it("requests a continuation for an inactive conversation", () => {
    detailSignal.value = detail({ isLive: false });
    const { getByRole } = render(h(DetailView, {}));
    const button = getByRole("button", { name: "Continue task" });
    expect(button.getAttribute("title")).toContain("usage limit resets");
    expect(button.getAttribute("title")).toContain("submit a request");
    post.mockClear(); // Ignore the transcript request emitted on mount.
    fireEvent.click(button);
    expect(post).toHaveBeenCalledExactlyOnceWith({
      type: "resumeSession",
      sessionId: "a",
      continueTask: true,
    });
  });

  it("keeps Continue task available for a quota-stopped official chat that is still live", () => {
    detailSignal.value = detail({ entrypoint: "claude-vscode", isLive: true, status: "idle" });
    const { getByRole } = render(h(DetailView, {}));
    expect(getByRole("button", { name: "View" })).toBeTruthy();
    post.mockClear(); // Ignore the transcript request emitted on mount.
    fireEvent.click(getByRole("button", { name: "Continue task" }));
    expect(post).toHaveBeenCalledExactlyOnceWith({
      type: "resumeSession",
      sessionId: "a",
      continueTask: true,
    });
  });

  it("opens a conversation without requesting continuation when Open conversation is clicked", () => {
    detailSignal.value = detail({ isLive: false });
    const { getByRole } = render(h(DetailView, {}));
    post.mockClear(); // Ignore the transcript request emitted on mount.
    fireEvent.click(getByRole("button", { name: "Open conversation" }));
    expect(post).toHaveBeenCalledExactlyOnceWith({
      type: "resumeSession",
      sessionId: "a",
      entrypoint: "cli",
      projectPath: "/p",
    });
  });

  it("continues the history for an existing worktree", () => {
    worktreesSignal.value = { a: ref() };
    detailSignal.value = detail();
    const { getByRole } = render(h(DetailView, {}));
    post.mockClear(); // Ignore the transcript request emitted on mount.
    fireEvent.click(getByRole("button", { name: "Continue task" }));
    expect(post).toHaveBeenCalledExactlyOnceWith({
      type: "resumeSession",
      sessionId: "a",
      continueTask: true,
    });
  });

  it.each(["claude", "user"] as const)(
    "does not offer task continuation when a %s worktree is missing",
    (kind) => {
      worktreesSignal.value = { a: ref({ exists: false, kind }) };
      detailSignal.value = detail();
      const { queryByRole } = render(h(DetailView, {}));
      expect(queryByRole("button", { name: "Continue task" })).toBeNull();
      expect(queryByRole("button", { name: "Open conversation" })).toBeNull();
    },
  );

  it("requires opening a different project before offering task continuation", () => {
    currentProjectSignal.value = "other";
    detailSignal.value = detail();
    const { queryByRole, getByRole } = render(h(DetailView, {}));
    expect(queryByRole("button", { name: "Continue task" })).toBeNull();
    expect(getByRole("button", { name: "Open proj" })).toBeTruthy();
  });
});


describe("DetailView — wait and auto-continue", () => {
  beforeEach(() => {
    _resetSessionsSignals(); post.mockClear(); currentProjectSignal.value = "proj";
  });

  it("offers a clock action that requests continuation in a new terminal", () => {
    detailSignal.value = detail({ isLive: false });
    const { getByRole } = render(h(DetailView, {}));
    const button = getByRole("button", { name: "Wait and auto-continue" });
    expect(button.getAttribute("title")).toContain("new terminal");
    expect(button.getAttribute("title")).toContain("usage limit resets");
    expect(button.querySelector('svg[data-icon="clock"]')).toBeTruthy();
    post.mockClear();
    fireEvent.click(button);
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: "waitAndContinueSession", sessionId: "a" });
  });

  it("remains available for a stopped official chat whose process is still live", () => {
    detailSignal.value = detail({ entrypoint: "claude-vscode", isLive: true, status: "idle" });
    const { getByRole } = render(h(DetailView, {}));
    expect(getByRole("button", { name: "View" })).toBeTruthy();
    post.mockClear();
    fireEvent.click(getByRole("button", { name: "Wait and auto-continue" }));
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: "waitAndContinueSession", sessionId: "a" });
  });

  it("is available for an existing sibling worktree of the current repository", async () => {
    const { setWorkspacePath } = await import("../../model");
    setWorkspacePath("/repo");
    worktreesSignal.value = { main: ref({ path: "/repo", kind: "main" }), a: ref() };
    detailSignal.value = detail({ projectKey: "sibling-worktree", projectPath: "/repo/.claude/worktrees/feat" });
    const { getByRole } = render(h(DetailView, {}));
    post.mockClear();
    fireEvent.click(getByRole("button", { name: "Wait and auto-continue" }));
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: "waitAndContinueSession", sessionId: "a" });
  });

  it.each(["claude", "user"] as const)("is unavailable when the %s checkout is missing", kind => {
    worktreesSignal.value = { a: ref({ exists: false, kind }) };
    detailSignal.value = detail();
    const { queryByRole } = render(h(DetailView, {}));
    expect(queryByRole("button", { name: "Wait and auto-continue" })).toBeNull();
  });

  it("requires opening an unrelated project before offering wait-and-continue", () => {
    currentProjectSignal.value = "other";
    detailSignal.value = detail();
    const { queryByRole, getByRole } = render(h(DetailView, {}));
    expect(queryByRole("button", { name: "Wait and auto-continue" })).toBeNull();
    expect(getByRole("button", { name: "Open proj" })).toBeTruthy();
  });
});

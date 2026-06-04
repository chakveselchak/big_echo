import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TodoistTaskPreview } from "../../types";
import { TodoistExportModal } from "./TodoistExportModal";

function preview(): TodoistTaskPreview {
  return {
    sessionId: "session-1",
    summaryPath: "/tmp/session/summary.md",
    warnings: [],
    items: [
      {
        id: "id-1",
        provider: "todoist",
        title: "Task one",
        description: null,
        due: "2026-06-05",
        priority: 3,
        assignee: null,
        context: "Context",
        sourceSessionId: "session-1",
        sourceFilePath: "/tmp/session/summary.md",
        status: "new",
        externalTaskId: null,
        error: null,
      },
      {
        id: "id-2",
        provider: "todoist",
        title: "Already synced",
        description: null,
        due: null,
        priority: 1,
        assignee: null,
        context: null,
        sourceSessionId: "session-1",
        sourceFilePath: "/tmp/session/summary.md",
        status: "synced",
        externalTaskId: "todoist-1",
        error: null,
      },
    ],
  };
}

describe("TodoistExportModal", () => {
  it("submits selected unsynced task IDs", async () => {
    const onAddSelected = vi.fn();

    render(
      <TodoistExportModal
        preview={preview()}
        open
        syncing={false}
        onCancel={vi.fn()}
        onAddSelected={onAddSelected}
      />,
    );

    await userEvent.click(screen.getByLabelText("Select Task one"));
    await userEvent.click(screen.getByRole("button", { name: "Add selected" }));

    expect(onAddSelected).toHaveBeenCalledWith(["id-1"]);
  });

  it("does not submit already synced tasks through add all", async () => {
    const onAddSelected = vi.fn();

    render(
      <TodoistExportModal
        preview={preview()}
        open
        syncing={false}
        onCancel={vi.fn()}
        onAddSelected={onAddSelected}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add all" }));

    expect(onAddSelected).toHaveBeenCalledWith(["id-1"]);
  });

  it("resets selected tasks when preview changes", async () => {
    const onAddSelected = vi.fn();
    const { rerender } = render(
      <TodoistExportModal
        preview={preview()}
        open
        syncing={false}
        onCancel={vi.fn()}
        onAddSelected={onAddSelected}
      />,
    );

    await userEvent.click(screen.getByLabelText("Select Task one"));
    expect(screen.getByRole("button", { name: "Add selected" })).toBeEnabled();

    rerender(
      <TodoistExportModal
        preview={{
          ...preview(),
          sessionId: "session-2",
          items: [
            {
              ...preview().items[0],
              id: "id-3",
              title: "Task three",
              sourceSessionId: "session-2",
            },
          ],
        }}
        open
        syncing={false}
        onCancel={vi.fn()}
        onAddSelected={onAddSelected}
      />,
    );

    expect(screen.getByRole("button", { name: "Add selected" })).toBeDisabled();
  });

  it("shows an empty state when no action items exist", () => {
    render(
      <TodoistExportModal
        preview={{ ...preview(), items: [] }}
        open
        syncing={false}
        onCancel={vi.fn()}
        onAddSelected={vi.fn()}
      />,
    );

    expect(screen.getByText("No action items found in this summary.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add all" })).toBeDisabled();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TodoistTaskPreview } from "../../types";
import { I18N_LANGUAGE_STORAGE_KEY, I18nProvider, type Language } from "../../i18n";
import { TodoistExportModal } from "./TodoistExportModal";

type TodoistExportModalProps = ComponentProps<typeof TodoistExportModal>;

function renderWithI18n(ui: ReactElement, language: Language = "en") {
  window.localStorage.setItem(I18N_LANGUAGE_STORAGE_KEY, language);
  return render(<I18nProvider>{ui}</I18nProvider>);
}

function renderModal(
  overrides: Partial<TodoistExportModalProps> = {},
  language: Language = "en",
) {
  return renderWithI18n(
    <TodoistExportModal
      preview={preview()}
      open
      syncing={false}
      onCancel={vi.fn()}
      onAddSelected={vi.fn()}
      {...overrides}
    />,
    language,
  );
}

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
        assignee: "Андрей",
        context: "Context",
        labels: ["project/acme", "call/sales"],
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
        labels: [],
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

    renderModal({ onAddSelected });

    await userEvent.click(screen.getByLabelText("Select Task one"));
    await userEvent.click(screen.getByRole("button", { name: "Add selected" }));

    expect(onAddSelected).toHaveBeenCalledWith(["id-1"]);
  });

  it("does not submit already synced tasks through add all", async () => {
    const onAddSelected = vi.fn();

    renderModal({ onAddSelected });

    await userEvent.click(screen.getByRole("button", { name: "Add all" }));

    expect(onAddSelected).toHaveBeenCalledWith(["id-1"]);
  });

  it("shows due and assignee with icons without internal status, priority, or source path", () => {
    renderModal();

    expect(screen.getByText("Task one")).toBeInTheDocument();
    expect(screen.getByLabelText("Due")).toHaveTextContent("2026-06-05");
    expect(screen.getByLabelText("Assignee")).toHaveTextContent("Андрей");
    expect(screen.queryByText(/Due:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ответственный:/)).not.toBeInTheDocument();
    expect(screen.queryByText("new")).not.toBeInTheDocument();
    expect(screen.queryByText("p3")).not.toBeInTheDocument();
    expect(screen.queryByText("/tmp/session/summary.md")).not.toBeInTheDocument();
  });

  it("renders action item context with an icon as secondary typography", () => {
    renderModal();

    expect(screen.getByText("Context").closest(".ant-typography")).toHaveClass(
      "ant-typography-secondary",
    );
    expect(document.body.querySelector(".anticon-align-left")).toBeInTheDocument();
  });

  it("renders synced status as a check icon without status text", () => {
    renderModal();

    expect(screen.queryByText("synced")).not.toBeInTheDocument();
    expect(document.body.querySelector(".anticon-check-circle")).toBeInTheDocument();
  });

  it("uses the task title as the checkbox label", async () => {
    const onAddSelected = vi.fn();

    renderModal({ onAddSelected });

    await userEvent.click(screen.getByText("Task one"));
    await userEvent.click(screen.getByRole("button", { name: "Add selected" }));

    expect(onAddSelected).toHaveBeenCalledWith(["id-1"]);
  });

  it("resets selected tasks when preview changes", async () => {
    const onAddSelected = vi.fn();
    const { rerender } = renderModal({ onAddSelected });

    await userEvent.click(screen.getByLabelText("Select Task one"));
    expect(screen.getByRole("button", { name: "Add selected" })).toBeEnabled();

    rerender(
      <I18nProvider>
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
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("button", { name: "Add selected" })).toBeDisabled();
  });

  it("shows an empty state when no action items exist", () => {
    renderModal({ preview: { ...preview(), items: [] } });

    expect(screen.getByText("No action items found in this summary.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add all" })).toBeDisabled();
  });

  it("localizes export modal controls in Russian", () => {
    renderModal({}, "ru");

    expect(screen.getByRole("dialog", { name: "Экспорт action items в Todoist" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Добавить выбранные" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Добавить все" })).toBeEnabled();
    expect(screen.getByLabelText("Срок")).toHaveTextContent("2026-06-05");
    expect(screen.getByLabelText("Ответственный")).toHaveTextContent("Андрей");
  });
});

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Input, Modal } from "antd";
import type { SummaryPromptView } from "../../types";

export type SummaryPromptDialogState = {
  sessionId: string;
  promptName: string;
  value: string;
  saving: boolean;
  notice?: string;
};

type SummaryPromptModalProps = {
  dialog: SummaryPromptDialogState | null;
  prompts: SummaryPromptView[];
  loadingPrompts: boolean;
  onCancel: () => void;
  onConfirm: (payload: { name: string; prompt: string }) => void;
};

export function SummaryPromptModal({
  dialog,
  prompts,
  loadingPrompts,
  onCancel,
  onConfirm,
}: SummaryPromptModalProps) {
  return (
    <Modal
      open={Boolean(dialog)}
      title="Управление промптами для саммари"
      closable={false}
      onCancel={onCancel}
      transitionName=""
      maskTransitionName=""
      footer={null}
      destroyOnClose
      className="summary-prompt-card"
    >
      {dialog && (
        <SummaryPromptModalBody
          key={dialog.sessionId}
          initialName={dialog.promptName}
          initialValue={dialog.value}
          prompts={prompts}
          loadingPrompts={loadingPrompts}
          saving={dialog.saving}
          notice={dialog.notice}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
    </Modal>
  );
}

type SummaryPromptModalBodyProps = {
  initialName: string;
  initialValue: string;
  prompts: SummaryPromptView[];
  loadingPrompts: boolean;
  saving: boolean;
  notice?: string;
  onCancel: () => void;
  onConfirm: (payload: { name: string; prompt: string }) => void;
};

// Owns the prompt draft locally so typing doesn't re-render SessionList (and
// all 50+ SessionCards) on every keystroke. The parent only learns the value
// on confirm.
function SummaryPromptModalBody({
  initialName,
  initialValue,
  prompts,
  loadingPrompts,
  saving,
  notice,
  onCancel,
  onConfirm,
}: SummaryPromptModalBodyProps) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState(initialValue);
  const [nameError, setNameError] = useState("");
  const [valueError, setValueError] = useState("");
  const touchedRef = useRef(false);
  const nameErrorId = "summary-prompt-name-error";
  const valueErrorId = "summary-prompt-value-error";

  // Accept async backfill from the parent (default-prompt IPC that resolves
  // after the modal opened with an empty value), but never clobber user edits.
  useEffect(() => {
    if (touchedRef.current) return;
    setName(initialName);
    setValue(initialValue);
  }, [initialName, initialValue]);

  const sortedPrompts = useMemo(
    () => [...prompts].sort((left, right) => left.name.localeCompare(right.name)),
    [prompts],
  );

  function selectPrompt(prompt: SummaryPromptView) {
    touchedRef.current = true;
    setName(prompt.name);
    setValue(prompt.prompt);
    setNameError("");
    setValueError("");
  }

  function handleConfirm() {
    const trimmedName = name.trim();
    const trimmedValue = value.trim();
    setNameError(trimmedName ? "" : "Введите имя промпта");
    setValueError(trimmedValue ? "" : "Введите текст промпта");
    if (!trimmedName || !trimmedValue) return;
    onConfirm({ name: trimmedName, prompt: value });
  }

  return (
    <>
      <div className="summary-prompt-editor">
        <div className="summary-prompt-sidebar">
          <div className="summary-prompt-list-label">Сохраненные промпты</div>
          <div className="summary-prompt-list" aria-label="Сохраненные промпты">
            {loadingPrompts ? (
              <div className="summary-prompt-list-empty">Загрузка...</div>
            ) : sortedPrompts.length ? (
              sortedPrompts.map((prompt) => (
                <button
                  key={prompt.name}
                  type="button"
                  className={
                    prompt.name === name
                      ? "summary-prompt-list-item summary-prompt-list-item-active"
                      : "summary-prompt-list-item"
                  }
                  onClick={() => selectPrompt(prompt)}
                  disabled={saving}
                  aria-pressed={prompt.name === name}
                >
                  {prompt.name}
                </button>
              ))
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет сохраненных промптов" />
            )}
          </div>
        </div>

        <div className="summary-prompt-fields">
          <label className="summary-prompt-field">
            <span>Имя промпта</span>
            <Input
              aria-label="Имя промпта"
              aria-describedby={nameError ? nameErrorId : undefined}
              aria-invalid={Boolean(nameError)}
              value={name}
              status={nameError ? "error" : undefined}
              onChange={(event) => {
                touchedRef.current = true;
                setName(event.target.value);
                if (nameError) setNameError("");
              }}
              disabled={saving}
            />
            {nameError && (
              <span id={nameErrorId} className="summary-prompt-error">
                {nameError}
              </span>
            )}
          </label>

          <label className="summary-prompt-field">
            <span>Текст промпта</span>
            <Input.TextArea
              aria-label="Текст промпта"
              aria-describedby={valueError ? valueErrorId : undefined}
              aria-invalid={Boolean(valueError)}
              rows={8}
              value={value}
              status={valueError ? "error" : undefined}
              onChange={(event) => {
                touchedRef.current = true;
                setValue(event.target.value);
                if (valueError) setValueError("");
              }}
              disabled={saving}
            />
            {valueError && (
              <span id={valueErrorId} className="summary-prompt-error">
                {valueError}
              </span>
            )}
          </label>
        </div>
      </div>
      {notice && <div className="summary-prompt-notice">{notice}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}>
        <Button onClick={onCancel} disabled={saving}>
          Отмена
        </Button>
        <Button type="primary" onClick={handleConfirm} loading={saving}>
          Ок
        </Button>
      </div>
    </>
  );
}

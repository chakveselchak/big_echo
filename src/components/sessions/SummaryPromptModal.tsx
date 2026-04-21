import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal } from "antd";

export type SummaryPromptDialogState = {
  sessionId: string;
  value: string;
  saving: boolean;
};

type SummaryPromptModalProps = {
  dialog: SummaryPromptDialogState | null;
  onCancel: () => void;
  onConfirm: (value: string) => void;
};

export function SummaryPromptModal({ dialog, onCancel, onConfirm }: SummaryPromptModalProps) {
  return (
    <Modal
      open={Boolean(dialog)}
      title="Промпт саммари"
      closable={false}
      onCancel={onCancel}
      transitionName=""
      maskTransitionName=""
      footer={null}
      destroyOnClose
    >
      {dialog && (
        <SummaryPromptModalBody
          key={dialog.sessionId}
          initialValue={dialog.value}
          saving={dialog.saving}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
    </Modal>
  );
}

type SummaryPromptModalBodyProps = {
  initialValue: string;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (value: string) => void;
};

// Owns the textarea draft locally so typing doesn't re-render SessionList (and
// all 50+ SessionCards) on every keystroke. The parent only learns the value
// on confirm.
function SummaryPromptModalBody({ initialValue, saving, onCancel, onConfirm }: SummaryPromptModalBodyProps) {
  const [value, setValue] = useState(initialValue);
  const touchedRef = useRef(false);

  // Accept async backfill from the parent (default-prompt IPC that resolves
  // after the modal opened with an empty value), but never clobber user edits.
  useEffect(() => {
    if (touchedRef.current) return;
    setValue(initialValue);
  }, [initialValue]);

  return (
    <>
      <Input.TextArea
        rows={8}
        value={value}
        onChange={(event) => {
          touchedRef.current = true;
          setValue(event.target.value);
        }}
        disabled={saving}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}>
        <Button onClick={onCancel} disabled={saving}>
          Отмена
        </Button>
        <Button type="primary" onClick={() => onConfirm(value)} loading={saving}>
          Ок
        </Button>
      </div>
    </>
  );
}

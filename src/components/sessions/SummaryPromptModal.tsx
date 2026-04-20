import { Button, Input, Modal } from "antd";

export type SummaryPromptDialogState = {
  sessionId: string;
  value: string;
  saving: boolean;
};

type SummaryPromptModalProps = {
  dialog: SummaryPromptDialogState | null;
  onCancel: () => void;
  onConfirm: () => void;
  onChange: (value: string) => void;
};

export function SummaryPromptModal({ dialog, onCancel, onConfirm, onChange }: SummaryPromptModalProps) {
  return (
    <Modal
      open={Boolean(dialog)}
      title="Промпт саммари"
      closable={false}
      onCancel={onCancel}
      transitionName=""
      maskTransitionName=""
      footer={[
        <Button key="cancel" onClick={onCancel} disabled={dialog?.saving}>Отмена</Button>,
        <Button key="ok" type="primary" onClick={onConfirm} loading={dialog?.saving}>Ок</Button>,
      ]}
    >
      {dialog && (
        <Input.TextArea
          rows={8}
          value={dialog.value}
          onChange={(e) => onChange(e.target.value)}
          disabled={dialog.saving}
        />
      )}
    </Modal>
  );
}

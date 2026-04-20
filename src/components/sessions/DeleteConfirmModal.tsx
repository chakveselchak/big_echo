import { useEffect, useRef } from "react";
import { Button, Modal } from "antd";

/**
 * Generic confirm-deletion modal.
 *
 * Reused by both "удалить сессию" and "удалить аудио" flows. The caller
 * controls everything via props — there is no hardcoded copy.
 *
 * Behavior:
 *   - Focus is moved into the Cancel button on open (non-destructive default).
 *   - Tab is trapped between Cancel and Delete so keyboard users can't
 *     accidentally focus back into the underlying session card.
 *   - While `pending` is true both buttons show loading/disabled state.
 */
type DeleteConfirmModalProps = {
  open: boolean;
  message: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

export function DeleteConfirmModal({
  open,
  message,
  pending,
  onCancel,
  onConfirm,
  title = "Подтверждение удаления",
  confirmLabel = "Удалить",
  cancelLabel = "Отмена",
}: DeleteConfirmModalProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      cancelButtonRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      if (document.activeElement === cancelButtonRef.current) {
        deleteButtonRef.current?.focus();
      } else {
        cancelButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  return (
    <Modal
      open={open}
      title={title}
      closable={false}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" ref={cancelButtonRef} autoFocus onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>,
        <Button key="delete" ref={deleteButtonRef} danger onClick={onConfirm} loading={pending}>
          {confirmLabel}
        </Button>,
      ]}
    >
      <p>{message}</p>
    </Modal>
  );
}

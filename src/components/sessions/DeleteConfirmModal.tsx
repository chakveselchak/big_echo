import { useEffect, useRef } from "react";
import { Button, Modal } from "antd";
import type { DeleteTarget } from "../../types";

type DeleteConfirmModalProps = {
  deleteTarget: DeleteTarget | null;
  deletePendingSessionId: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteConfirmModal({ deleteTarget, deletePendingSessionId, onCancel, onConfirm }: DeleteConfirmModalProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const isOpen = Boolean(deleteTarget);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      cancelButtonRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
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
  }, [isOpen]);

  return (
    <Modal
      open={isOpen}
      title="Подтверждение удаления"
      closable={false}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" ref={cancelButtonRef} autoFocus onClick={onCancel} disabled={deletePendingSessionId !== null}>
          Отмена
        </Button>,
        <Button key="delete" ref={deleteButtonRef} danger onClick={onConfirm} loading={deletePendingSessionId !== null}>
          Удалить
        </Button>,
      ]}
    >
      <p>
        {deleteTarget?.force
          ? "Сессия помечена как активная. Принудительно удалить сессию и все связанные файлы?"
          : "Удалить сессию и все связанные файлы?"}
      </p>
    </Modal>
  );
}

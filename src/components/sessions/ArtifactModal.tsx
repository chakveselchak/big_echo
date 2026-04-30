import { useEffect, useRef } from "react";
import { Button, Modal, Typography } from "antd";
import type { SessionArtifactPreview } from "../../types";
import { renderHighlightedText } from "../../lib/appUtils";

type ArtifactModalProps = {
  preview: SessionArtifactPreview | null;
  onClose: () => void;
  onOpenInEditor?: () => void | Promise<void>;
};

export function ArtifactModal({ preview, onClose, onOpenInEditor }: ArtifactModalProps) {
  const bodyRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!preview) return;
    const firstMatch = bodyRef.current?.querySelector("mark");
    if (!(firstMatch instanceof HTMLElement) || typeof firstMatch.scrollIntoView !== "function") return;
    firstMatch.scrollIntoView({ block: "center" });
  }, [preview]);

  const footer = onOpenInEditor
    ? [
        <Button key="open" type="primary" onClick={() => void onOpenInEditor()}>
          Открыть
        </Button>,
        <Button key="close" onClick={onClose}>
          Закрыть
        </Button>,
      ]
    : [<Button key="close" onClick={onClose}>Закрыть</Button>];

  return (
    <Modal
      open={Boolean(preview)}
      title="Просмотр артефакта"
      closable={false}
      onCancel={onClose}
      footer={footer}
      aria-label="Просмотр артефакта"
    >
      {preview && (
        <>
          <Typography.Text strong>
            {preview.artifactKind === "transcript" ? "Текст" : "Саммари"}
          </Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            {preview.path}
          </Typography.Paragraph>
          <pre
            ref={bodyRef}
            className="artifact-preview-text"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 400, overflowY: "auto" }}
          >
            {renderHighlightedText(preview.text, preview.query)}
          </pre>
        </>
      )}
    </Modal>
  );
}

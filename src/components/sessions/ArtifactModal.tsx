import { useEffect, useRef } from "react";
import { Button, Modal, Typography } from "antd";
import type { SessionArtifactPreview } from "../../types";
import { renderHighlightedText } from "../../lib/appUtils";

type ArtifactModalProps = {
  preview: SessionArtifactPreview | null;
  onClose: () => void;
  onOpenInEditor?: () => void | Promise<void>;
};

const MATCHED_PREVIEW_CONTEXT_CHARS = 900;

function buildMatchedPreviewText(text: string, query: string): string {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return text;
  const matchIndex = text.toLowerCase().indexOf(normalizedQuery.toLowerCase());
  if (matchIndex === -1) return text;
  const start = Math.max(0, matchIndex - MATCHED_PREVIEW_CONTEXT_CHARS);
  const end = Math.min(
    text.length,
    matchIndex + normalizedQuery.length + MATCHED_PREVIEW_CONTEXT_CHARS,
  );
  if (start === 0 && end === text.length) return text;
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export function ArtifactModal({ preview, onClose, onOpenInEditor }: ArtifactModalProps) {
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const previewText = preview ? buildMatchedPreviewText(preview.text, preview.query) : "";

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
            data-testid="artifact-preview-body"
            className="artifact-preview-text"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 400, overflowY: "auto" }}
          >
            {renderHighlightedText(previewText, preview.query)}
          </pre>
        </>
      )}
    </Modal>
  );
}

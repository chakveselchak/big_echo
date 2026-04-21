import { Button, Typography } from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tauriInvoke } from "../../lib/tauri";
import type { UpdateInfo } from "../../types";

type Props = {
  updateInfo: UpdateInfo;
};

function formatPublishedAt(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString();
}

function openExternal(url: string): void {
  if (!url) return;
  void tauriInvoke<void>("open_external_url", { url }).catch((err) => {
    console.warn("open_external_url failed", err);
  });
}

export function NewVersionPage({ updateInfo }: Props) {
  const published = formatPublishedAt(updateInfo.published_at);

  return (
    <div style={{ padding: 20, overflowY: "auto" }}>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        New version {updateInfo.latest} available
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        You are on {updateInfo.current}
        {published ? ` · Released ${published}` : ""}
      </Typography.Paragraph>

      <div className="release-notes">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children, ...rest }) => (
              <a
                {...rest}
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  if (href) openExternal(href);
                }}
              >
                {children}
              </a>
            ),
          }}
        >
          {updateInfo.body || "_No release notes provided._"}
        </ReactMarkdown>
      </div>

      <Button
        type="primary"
        href={updateInfo.html_url}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          event.preventDefault();
          openExternal(updateInfo.html_url);
        }}
        style={{ marginTop: 16 }}
      >
        View on GitHub
      </Button>
    </div>
  );
}

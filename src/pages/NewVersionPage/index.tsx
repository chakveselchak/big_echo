import { Button, Typography } from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
              <a href={href} target="_blank" rel="noreferrer" {...rest}>
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
        style={{ marginTop: 16 }}
      >
        View on GitHub
      </Button>
    </div>
  );
}

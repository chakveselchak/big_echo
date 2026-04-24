import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Flex,
  Form,
  Input,
  Progress,
  Select,
  Space,
  Tag,
} from "antd";
import { LinkOutlined } from "@ant-design/icons";
import type { PublicSettings } from "../../types";
import { tauriInvoke } from "../../lib/tauri";
import { useYandexSync } from "../../hooks/useYandexSync";

type Props = {
  settings: PublicSettings;
  setSettings: (s: PublicSettings) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
  enabled: boolean;
};

const TOKEN_URL = "https://yandex.ru/dev/disk/poligon/";

const dirtyDot = (
  <span
    style={{
      display: "inline-block",
      width: 6,
      height: 6,
      borderRadius: "50%",
      backgroundColor: "var(--ant-color-warning, #faad14)",
      marginLeft: 4,
      verticalAlign: "middle",
    }}
    aria-hidden="true"
  />
);

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

export function YandexSyncSettings({ settings, setSettings, isDirty, enabled }: Props) {
  const y = useYandexSync(enabled);
  const [tokenInput, setTokenInput] = useState("");

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) return;
    await y.saveToken(tokenInput.trim());
    setTokenInput("");
  };

  const openTokenPage = () => {
    void tauriInvoke("open_external_url", { url: TOKEN_URL });
  };

  const tokenBadge = y.tokenState === "error"
    ? <Tag color="red">Error</Tag>
    : y.hasToken
      ? <Tag color="green">Saved</Tag>
      : <Tag>Not set</Tag>;

  const canSyncNow = y.hasToken && !y.status.is_running;
  const fieldsDisabled = !settings.yandex_sync_enabled;

  return (
    <Form layout="vertical" style={{ maxWidth: 760 }}>
      <Form.Item>
        <Checkbox
          id="yandex_sync_enabled"
          aria-label="Enable Yandex.Disk sync"
          checked={Boolean(settings.yandex_sync_enabled)}
          onChange={(e) =>
            setSettings({ ...settings, yandex_sync_enabled: e.target.checked })
          }
        >
          Enable Yandex.Disk sync
          {isDirty("yandex_sync_enabled") && dirtyDot}
        </Checkbox>
      </Form.Item>

      <Form.Item label={<label htmlFor="yandex_sync_token">OAuth token</label>}>
        <Flex gap={8} align="center" wrap="wrap">
          <Input.Password
            id="yandex_sync_token"
            placeholder="OAuth token from oauth.yandex.ru"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            style={{ flex: "1 1 260px" }}
          />
          <Button type="primary" onClick={() => void handleSaveToken()}>
            Save token
          </Button>
          {tokenBadge}
          <Button onClick={() => void y.clearToken()} disabled={!y.hasToken}>
            Clear
          </Button>
        </Flex>
        <Flex gap={8} align="center" style={{ marginTop: 8 }}>
          <Button icon={<LinkOutlined aria-hidden="true" />} onClick={openTokenPage}>
            Get token
          </Button>
          <span style={{ color: "#888" }}>Opens Yandex.Disk Polygon in your browser.</span>
        </Flex>
      </Form.Item>

      <Form.Item
        label={
          <label htmlFor="yandex_sync_remote_folder">
            Folder on Yandex.Disk (will be created if missing)
            {isDirty("yandex_sync_remote_folder") && dirtyDot}
          </label>
        }
      >
        <Input
          id="yandex_sync_remote_folder"
          value={settings.yandex_sync_remote_folder}
          onChange={(e) =>
            setSettings({ ...settings, yandex_sync_remote_folder: e.target.value })
          }
          disabled={fieldsDisabled}
        />
      </Form.Item>

      <Form.Item
        label={
          <label htmlFor="yandex_sync_interval">
            Sync interval
            {isDirty("yandex_sync_interval") && dirtyDot}
          </label>
        }
        help={`Runs on app startup and every ${settings.yandex_sync_interval} while the app is running.`}
      >
        <Select
          id="yandex_sync_interval"
          value={settings.yandex_sync_interval}
          disabled={fieldsDisabled}
          onChange={(value) =>
            setSettings({
              ...settings,
              yandex_sync_interval: value as PublicSettings["yandex_sync_interval"],
            })
          }
          options={[
            { value: "1h", label: "Every hour" },
            { value: "6h", label: "Every 6 hours" },
            { value: "24h", label: "Every 24 hours" },
            { value: "48h", label: "Every 48 hours" },
          ]}
        />
      </Form.Item>

      <Form.Item>
        <Button
          type="primary"
          onClick={() => void y.syncNow()}
          loading={y.status.is_running}
          disabled={!canSyncNow}
        >
          Sync now
        </Button>
      </Form.Item>

      {y.status.is_running && y.progress && (
        <div style={{ marginBottom: 12 }}>
          <div>
            Processing {y.progress.current} / {y.progress.total}: <code>{y.progress.rel_path}</code>
          </div>
          <Progress
            percent={
              y.progress.total > 0
                ? Math.round((y.progress.current * 100) / y.progress.total)
                : 0
            }
            size="small"
          />
        </div>
      )}

      {y.status.last_run && (
        <Alert
          type={y.status.last_run.failed > 0 ? "warning" : "success"}
          message={
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              <div>
                Last sync: {new Date(y.status.last_run.finished_at_iso).toLocaleString()} (
                {formatDuration(y.status.last_run.duration_ms)})
              </div>
              <div>
                Uploaded {y.status.last_run.uploaded} · Skipped {y.status.last_run.skipped} · Failed{" "}
                {y.status.last_run.failed}
              </div>
              {y.status.last_run.failed > 0 && (
                <Collapse
                  size="small"
                  items={[
                    {
                      key: "errors",
                      label: "Show errors",
                      children: (
                        <ul style={{ margin: 0, paddingLeft: 20 }}>
                          {y.status.last_run.errors.slice(0, 20).map((e, i) => (
                            <li key={`${e.path}-${i}`}>
                              <code>{e.path}</code> — {e.message}
                            </li>
                          ))}
                        </ul>
                      ),
                    },
                  ]}
                />
              )}
            </Space>
          }
        />
      )}
    </Form>
  );
}

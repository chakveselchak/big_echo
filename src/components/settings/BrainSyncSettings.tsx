import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Checkbox, Flex, Form, Input, Progress, Space, Tag, Typography } from "antd";
import type { PublicSettings } from "../../types";
import { tauriInvoke, tauriListen } from "../../lib/tauri";

type Props = {
  settings: PublicSettings;
  setSettings: (s: PublicSettings) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
};

type BrainArchiveUploadProgress = {
  total: number;
  processed: number;
  uploaded: number;
  skipped: number;
  failed: number;
  current_session_id: string | null;
  current_title: string | null;
  errors: string[];
};

type BrainArchiveUploadSummary = {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  errors: string[];
};

type TauriPayloadEvent<T> = { payload: T };

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

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function summaryText(summary: BrainArchiveUploadSummary): string {
  return `Готово: всего ${summary.total}, загружено ${summary.uploaded}, пропущено ${summary.skipped}, ошибок ${summary.failed}`;
}

export function BrainSyncSettings({ settings, setSettings, isDirty }: Props) {
  const [tokenInput, setTokenInput] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [tokenState, setTokenState] = useState<"loading" | "ready" | "error">("loading");
  const [archiveRunning, setArchiveRunning] = useState(false);
  const [archiveProgress, setArchiveProgress] = useState<BrainArchiveUploadProgress | null>(null);
  const [archiveSummary, setArchiveSummary] = useState<BrainArchiveUploadSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmedUrl = settings.brain_sync_url.trim();
  const urlIsValid = trimmedUrl.length > 0 && isValidHttpUrl(trimmedUrl);
  const isBrainUrlDirty = isDirty("brain_sync_url");
  const canUploadArchive = hasToken && urlIsValid && !isBrainUrlDirty && !archiveRunning;

  const tokenBadge = useMemo(() => {
    if (tokenState === "loading") return <Tag>Проверка токена…</Tag>;
    if (tokenState === "error") return <Tag color="red">Ошибка проверки токена</Tag>;
    return hasToken ? <Tag color="green">Токен сохранён</Tag> : <Tag>Токен не сохранён</Tag>;
  }, [hasToken, tokenState]);

  async function refreshHasToken() {
    setTokenState("loading");
    try {
      const result = await tauriInvoke<boolean>("brain_sync_has_token");
      setHasToken(result);
      setTokenState("ready");
    } catch (err) {
      setHasToken(false);
      setTokenState("error");
      setError(`Не удалось проверить токен Brain: ${String(err)}`);
    }
  }

  useEffect(() => {
    void refreshHasToken();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void tauriListen("brain-archive-upload-progress", (event) => {
      if (!cancelled) {
        const payload = (event as TauriPayloadEvent<BrainArchiveUploadProgress>).payload;
        setArchiveProgress(payload);
      }
    })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch(() => {
        if (!cancelled) setError("Не удалось подписаться на прогресс архивной загрузки Brain");
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  async function handleSaveToken() {
    const token = tokenInput.trim();
    if (!token) return;
    setError(null);
    try {
      await tauriInvoke("brain_sync_set_token", { token });
      setTokenInput("");
      setHasToken(true);
      setTokenState("ready");
    } catch {
      setTokenState("error");
      setError("Не удалось сохранить токен Brain");
    }
  }

  async function handleClearToken() {
    setError(null);
    try {
      await tauriInvoke("brain_sync_clear_token");
      setHasToken(false);
      setTokenState("ready");
    } catch {
      setTokenState("error");
      setError("Не удалось очистить токен Brain");
    }
  }

  async function handleArchiveUpload() {
    setArchiveSummary(null);
    setError(null);
    if (!urlIsValid) {
      setError("Укажите корректный URL загрузки в Brain перед архивной загрузкой.");
      return;
    }
    if (!hasToken) {
      setError("Сохраните персональный токен Brain перед архивной загрузкой.");
      return;
    }
    if (isBrainUrlDirty) {
      setError("Сначала сохраните URL загрузки в Brain");
      return;
    }

    setArchiveRunning(true);
    setArchiveProgress(null);
    try {
      const summary = await tauriInvoke<BrainArchiveUploadSummary>("brain_sync_upload_archive");
      setArchiveSummary(summary);
    } catch (err) {
      setError(`Архивная загрузка Brain не запущена: ${String(err)}`);
    } finally {
      setArchiveRunning(false);
    }
  }

  return (
    <Form layout="vertical" style={{ maxWidth: 760 }}>
      <Form.Item>
        <CheckboxWithDirty
          checked={Boolean(settings.brain_sync_enabled)}
          dirty={isDirty("brain_sync_enabled")}
          onChange={(checked) => setSettings({ ...settings, brain_sync_enabled: checked })}
        />
      </Form.Item>

      <Form.Item
        label={
          <label htmlFor="brain_sync_url">
            URL загрузки в Brain{isDirty("brain_sync_url") && dirtyDot}
          </label>
        }
        help="Новые записи загружаются после локального сохранения audio-файла."
      >
        <Input
          id="brain_sync_url"
          value={settings.brain_sync_url}
          onChange={(e) => setSettings({ ...settings, brain_sync_url: e.target.value })}
        />
      </Form.Item>

      <Form.Item label={<label htmlFor="brain_sync_token">Персональный токен Brain</label>}>
        <Flex gap={8} align="center" wrap="wrap">
          <Input.Password
            id="brain_sync_token"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            style={{ flex: "1 1 260px" }}
          />
          <Button
            type="primary"
            disabled={!tokenInput.trim()}
            onClick={() => void handleSaveToken()}
          >
            Сохранить токен
          </Button>
          <Button disabled={!hasToken} onClick={() => void handleClearToken()}>
            Очистить токен
          </Button>
          {tokenBadge}
        </Flex>
      </Form.Item>

      <Space direction="vertical" size={8} style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary">
          Локальную транскрипцию можно выключить отдельно в существующих настройках pipeline.
        </Typography.Text>
        <Typography.Text type="secondary">
          Архивная загрузка отправляет ранее сохранённые audio-файлы по очереди; уже загруженные
          записи пропускаются локально или идемпотентно на сервере.
        </Typography.Text>
      </Space>

      {(!hasToken || !urlIsValid || isBrainUrlDirty) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            isBrainUrlDirty
              ? "Сначала сохраните URL загрузки в Brain"
              : !hasToken
                ? "Для архивной загрузки Brain сохраните персональный токен."
                : "Для архивной загрузки Brain укажите корректный URL."
          }
        />
      )}

      {error && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}

      {archiveRunning && archiveProgress && (
        <div style={{ marginBottom: 12 }}>
          <div>
            Обработано {archiveProgress.processed} / {archiveProgress.total}
            {archiveProgress.current_title ? `: ${archiveProgress.current_title}` : ""}
          </div>
          <div>
            Загружено {archiveProgress.uploaded} · Пропущено {archiveProgress.skipped} · Ошибок{" "}
            {archiveProgress.failed}
          </div>
          <Progress
            percent={
              archiveProgress.total > 0
                ? Math.round((archiveProgress.processed * 100) / archiveProgress.total)
                : 0
            }
            size="small"
          />
        </div>
      )}

      {archiveSummary && (
        <Alert
          type={archiveSummary.failed > 0 ? "warning" : "success"}
          message={summaryText(archiveSummary)}
          style={{ marginBottom: 12 }}
        />
      )}

      <Button
        type="primary"
        disabled={!canUploadArchive}
        loading={archiveRunning}
        onClick={() => void handleArchiveUpload()}
      >
        Загрузить архивные записи
      </Button>
    </Form>
  );
}

function CheckboxWithDirty({
  checked,
  dirty,
  onChange,
}: {
  checked: boolean;
  dirty: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Checkbox
      id="brain_sync_enabled"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    >
      Автоматически загружать новые записи в Brain
      {dirty && dirtyDot}
    </Checkbox>
  );
}

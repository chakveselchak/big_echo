import { useCallback, useEffect, useState } from "react";
import { Button, Col, Form, Input, Progress, Tag } from "antd";
import { listen } from "@tauri-apps/api/event";
import type {
  AppleSpeechCheckResult,
  AppleSpeechDownloadProgress,
  PublicSettings,
} from "../../types";
import { tauriInvoke } from "../../lib/tauri";

type AppleSpeechSectionProps = {
  settings: PublicSettings;
  setSettings: (s: PublicSettings) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
  dirtyDot: React.ReactNode;
};

function statusLabel(status: AppleSpeechCheckResult["assetStatus"]) {
  switch (status) {
    case "installed":
      return { color: "green", text: "Установлено" };
    case "supported":
      return { color: "blue", text: "Доступно к скачиванию" };
    case "downloading":
      return { color: "processing", text: "Скачивается…" };
    case "unsupported":
      return { color: "orange", text: "Только через системные настройки" };
    default:
      return { color: "default", text: "Неизвестно" };
  }
}

export function AppleSpeechSection({
  settings,
  setSettings,
  isDirty,
  dirtyDot,
}: AppleSpeechSectionProps) {
  const [check, setCheck] = useState<AppleSpeechCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const locale = settings.apple_speech_locale.trim() || "ru_RU";

  const refreshCheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await tauriInvoke<AppleSpeechCheckResult>(
        "apple_speech_check_locale",
        { locale }
      );
      setCheck(result);
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
      setCheck(null);
    } finally {
      setChecking(false);
    }
  }, [locale]);

  useEffect(() => {
    void refreshCheck();
  }, [refreshCheck]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      unlisten = await listen<AppleSpeechDownloadProgress>(
        "apple-speech://download-progress",
        (event) => {
          if (event.payload.locale === locale) {
            setDownloadProgress(event.payload.progress);
          }
        }
      );
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [locale]);

  async function handleDownload() {
    setDownloading(true);
    setDownloadProgress(0);
    setError(null);
    try {
      await tauriInvoke("apple_speech_download_locale", { locale });
      await refreshCheck();
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
    }
  }

  async function handleOpenDictation() {
    try {
      await tauriInvoke("apple_speech_open_dictation_settings");
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    }
  }

  const status = check ? statusLabel(check.assetStatus) : null;
  const canDownload = check?.assetStatus === "supported" || check?.assetStatus === "downloading";
  const needsSystemSettings = check?.assetStatus === "unsupported";

  return (
    <>
      <Col xs={24} md={12}>
        <Form.Item
          label={
            <label htmlFor="apple_speech_locale">
              Локаль{isDirty("apple_speech_locale") && dirtyDot}
            </label>
          }
          extra="Например: ru_RU, en_US, de_DE"
        >
          <Input
            id="apple_speech_locale"
            aria-label="Apple Speech locale"
            value={settings.apple_speech_locale}
            onChange={(e) =>
              setSettings({ ...settings, apple_speech_locale: e.target.value })
            }
          />
        </Form.Item>
      </Col>

      <Col xs={24} md={12}>
        <Form.Item label="Статус модели">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {status && <Tag color={status.color}>{status.text}</Tag>}
              {check && (
                <span style={{ fontSize: 12, color: "var(--ant-color-text-secondary, #888)" }}>
                  {check.resolved}
                </span>
              )}
              <Button size="small" onClick={() => void refreshCheck()} loading={checking}>
                Обновить
              </Button>
            </div>
            {downloading && downloadProgress !== null && (
              <Progress percent={Math.round(downloadProgress * 100)} size="small" />
            )}
            {error && (
              <span style={{ color: "var(--ant-color-error, #cf1322)", fontSize: 12 }}>
                {error}
              </span>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              {canDownload && (
                <Button type="primary" onClick={() => void handleDownload()} loading={downloading}>
                  Скачать модель
                </Button>
              )}
              {needsSystemSettings && (
                <Button onClick={() => void handleOpenDictation()}>
                  Открыть настройки диктовки
                </Button>
              )}
            </div>
            {needsSystemSettings && (
              <span style={{ fontSize: 12, color: "var(--ant-color-text-secondary, #888)" }}>
                Эта локаль не скачивается через API. Откройте «Настройки → Клавиатура → Диктовка»,
                добавьте язык и выберите режим «На устройстве».
              </span>
            )}
          </div>
        </Form.Item>
      </Col>
    </>
  );
}

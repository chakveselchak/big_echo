import { useEffect, useState } from "react";
import { Button, Checkbox, Flex, Form, Input, Tag } from "antd";
import type { UseTodoistSyncReturn } from "../../hooks/useTodoistSync";
import type { PublicSettings } from "../../types";

type Props = {
  settings: PublicSettings;
  setSettings: (s: PublicSettings) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
  todoistSync: UseTodoistSyncReturn;
};

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

export function TodoistSyncSettings({ settings, setSettings, isDirty, todoistSync }: Props) {
  const [tokenInput, setTokenInput] = useState("");

  const handleSaveToken = async () => {
    const token = tokenInput.trim();
    if (!token) return;
    const saved = await todoistSync.saveToken(token);
    if (saved) {
      setTokenInput("");
    }
  };

  const handleClearToken = async () => {
    const cleared = await todoistSync.clearToken();
    if (cleared && settings.todoist_auto_add) {
      setSettings({ ...settings, todoist_auto_add: false });
    }
  };

  const handleSyncEnabledChange = (checked: boolean) => {
    setSettings({
      ...settings,
      todoist_sync_enabled: checked,
      todoist_auto_add: checked ? settings.todoist_auto_add : false,
    });
  };

  const tokenBadge = todoistSync.tokenState === "error"
    ? <Tag color="red">Error</Tag>
    : todoistSync.hasToken
      ? <Tag color="green">Saved</Tag>
      : <Tag>Not set</Tag>;

  const autoAddDisabled = !settings.todoist_sync_enabled || !todoistSync.hasToken;

  useEffect(() => {
    if (autoAddDisabled && settings.todoist_auto_add) {
      setSettings({ ...settings, todoist_auto_add: false });
    }
  }, [autoAddDisabled, settings, setSettings]);

  return (
    <Form layout="vertical" style={{ maxWidth: 760 }}>
      <Form.Item>
        <Checkbox
          id="todoist_sync_enabled"
          aria-label="Enable Todoist sync"
          checked={Boolean(settings.todoist_sync_enabled)}
          onChange={(e) => handleSyncEnabledChange(e.target.checked)}
        >
          Enable Todoist sync
          {isDirty("todoist_sync_enabled") && dirtyDot}
        </Checkbox>
      </Form.Item>

      <Form.Item label={<label htmlFor="todoist_api_token">API token</label>}>
        <Flex gap={8} align="center" wrap="wrap">
          <Input.Password
            id="todoist_api_token"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            style={{ flex: "1 1 260px" }}
          />
          <Button
            type="primary"
            onClick={() => void handleSaveToken()}
            disabled={!tokenInput.trim()}
          >
            Save token
          </Button>
          {todoistSync.hasToken && (
            <Button onClick={() => void handleClearToken()}>
              Clear token
            </Button>
          )}
          {tokenBadge}
        </Flex>
      </Form.Item>

      <Form.Item>
        <Checkbox
          id="todoist_auto_add"
          aria-label="Auto-add action items"
          checked={Boolean(settings.todoist_auto_add)}
          disabled={autoAddDisabled}
          onChange={(e) =>
            setSettings({ ...settings, todoist_auto_add: e.target.checked })
          }
        >
          Auto-add action items
          {isDirty("todoist_auto_add") && dirtyDot}
        </Checkbox>
      </Form.Item>
    </Form>
  );
}

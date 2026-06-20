import { useEffect, useMemo, useState } from "react";
import {
  AlignLeftOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Button, Checkbox, Empty, List, Modal, Space, Tag, Typography } from "antd";
import type { CheckboxChangeEvent } from "antd/es/checkbox";
import type { TodoistActionItem, TodoistTaskPreview } from "../../types";
import { useI18n } from "../../i18n";

type TodoistExportModalProps = {
  preview: TodoistTaskPreview | null;
  open: boolean;
  syncing: boolean;
  onCancel: () => void;
  onAddSelected: (taskIds: string[]) => void;
};

const taskMetaIconStyle = { color: "#000" };
const syncedIconStyle = { color: "#52c41a", marginLeft: 6 };

function statusColor(status: TodoistActionItem["status"]) {
  if (status === "synced") return "green";
  if (status === "failed") return "red";
  if (status === "queued" || status === "syncing") return "blue";
  if (status === "skipped") return "default";
  return "gold";
}

export function TodoistExportModal({
  preview,
  open,
  syncing,
  onCancel,
  onAddSelected,
}: TodoistExportModalProps) {
  const { t } = useI18n();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectableIds = useMemo(
    () => preview?.items.filter((item) => item.status !== "synced").map((item) => item.id) ?? [],
    [preview],
  );
  const hasItems = Boolean(preview?.items.length);

  useEffect(() => {
    setSelectedIds([]);
  }, [open, preview?.sessionId]);

  function setChecked(taskId: string, checked: boolean) {
    setSelectedIds((current) => {
      if (checked) return current.includes(taskId) ? current : [...current, taskId];
      return current.filter((id) => id !== taskId);
    });
  }

  function addSelected() {
    onAddSelected(selectedIds);
  }

  const footer = [
    <Button key="cancel" onClick={onCancel}>
      {t("common.cancel")}
    </Button>,
    <Button
      key="selected"
      disabled={!selectedIds.length}
      loading={syncing}
      onClick={addSelected}
    >
      {t("todoistExport.addSelected")}
    </Button>,
    <Button
      key="all"
      type="primary"
      disabled={!selectableIds.length}
      loading={syncing}
      onClick={() => onAddSelected(selectableIds)}
    >
      {t("todoistExport.addAll")}
    </Button>,
  ];
  const title = t("todoistExport.title");

  return (
    <Modal
      open={open}
      title={title}
      closable={false}
      onCancel={onCancel}
      footer={footer}
      aria-label={title}
      width={720}
    >
      {preview?.warnings.length ? (
        <Space direction="vertical" size={4} style={{ width: "100%", marginBottom: 12 }}>
          {preview.warnings.map((warning) => (
            <Typography.Text key={warning} type="warning">
              {warning}
            </Typography.Text>
          ))}
        </Space>
      ) : null}

      {!hasItems ? (
        <Empty description={t("todoistExport.empty")} />
      ) : (
        <List
          dataSource={preview?.items ?? []}
          renderItem={(item) => {
            const disabled = item.status === "synced";
            const checkboxId = `todoist-export-${item.id}`;
            return (
              <List.Item>
                <List.Item.Meta
                  avatar={
                    <Checkbox
                      id={checkboxId}
                      aria-label={t("todoistExport.selectTask", { title: item.title })}
                      checked={selectedIds.includes(item.id)}
                      disabled={disabled || syncing}
                      onChange={(event: CheckboxChangeEvent) => setChecked(item.id, event.target.checked)}
                    />
                  }
                  title={
                    <label htmlFor={checkboxId}>
                      <Space size={8} wrap>
                        <Typography.Text strong>
                          {item.title}
                          {item.status === "synced" ? (
                            <CheckCircleOutlined
                              aria-label={t("todoistExport.synced")}
                              style={syncedIconStyle}
                            />
                          ) : null}
                        </Typography.Text>
                        {item.status !== "new" && item.status !== "synced" ? (
                          <Tag color={statusColor(item.status)}>{item.status}</Tag>
                        ) : null}
                      </Space>
                    </label>
                  }
                  description={
                    <Space direction="vertical" size={2} style={{ width: "100%" }}>
                      {item.due ? (
                        <Typography.Text aria-label={t("todoistExport.due")} type="secondary">
                          <Space size={6}>
                            <CalendarOutlined aria-hidden style={taskMetaIconStyle} />
                            <span>{item.due}</span>
                          </Space>
                        </Typography.Text>
                      ) : null}
                      {item.assignee ? (
                        <Typography.Text aria-label={t("todoistExport.assignee")} type="secondary">
                          <Space size={6}>
                            <UserOutlined aria-hidden style={taskMetaIconStyle} />
                            <span>{item.assignee}</span>
                          </Space>
                        </Typography.Text>
                      ) : null}
                      {item.context ? (
                        <Typography.Text type="secondary">
                          <Space size={6}>
                            <AlignLeftOutlined aria-hidden style={taskMetaIconStyle} />
                            <span>{item.context}</span>
                          </Space>
                        </Typography.Text>
                      ) : null}
                      {item.error ? <Typography.Text type="danger">{item.error}</Typography.Text> : null}
                    </Space>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}
    </Modal>
  );
}

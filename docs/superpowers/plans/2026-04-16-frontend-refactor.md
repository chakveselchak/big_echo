# Frontend Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the frontend from a 1774-line monolithic `App.tsx` into focused page and component files, replace glassmorphism CSS with standard Ant Design, and establish a modern directory structure.

**Architecture:** Page-by-page extraction (TrayPage → SettingsPage → MainPage). Each page calls its own hooks. Shared settings components live in `components/settings/` and are used by both `SettingsPage` and `MainPage`. `App.tsx` becomes a pure router.

**Tech Stack:** React 18, TypeScript, Ant Design 5, Tauri 2, Vitest + @testing-library/react

---

## File Structure

### Created
```
src/types/index.ts                              ← appTypes.ts content (renamed)
src/lib/status.ts                               ← status.ts (moved)
src/lib/trayAudio.ts                            ← features/recording/trayAudio.ts (moved)
src/lib/trayAudio.test.ts                       ← features/recording/trayAudio.test.ts (moved)
src/theme/index.ts                              ← new: simple ThemeConfig
src/hooks/useRecordingController.ts             ← features/recording/ (moved)
src/hooks/useRecordingController.test.ts        ← features/recording/ (moved)
src/hooks/useSessions.ts                        ← features/sessions/ (moved)
src/hooks/useSessions.test.tsx                  ← features/sessions/ (moved)
src/hooks/useSettingsForm.ts                    ← features/settings/ (moved)
src/hooks/useSettingsForm.test.tsx              ← features/settings/ (moved)
src/components/tray/AudioWave.tsx               ← TrayAudioWave.tsx (moved + updated imports)
src/components/tray/AudioWave.test.tsx          ← TrayAudioWave.test.tsx (moved + updated imports)
src/components/tray/AudioRow.tsx                ← TrayAudioRow.tsx (moved + Ant Design layout)
src/components/tray/RecordingControls.tsx       ← new: source/topic inputs
src/pages/TrayPage/index.tsx                    ← new: tray window
src/components/settings/GeneralSettings.tsx     ← new: generals tab fields
src/components/settings/TranscriptionSettings.tsx ← new: audiototext tab fields
src/components/settings/AudioSettings.tsx       ← new: audio tab fields
src/pages/SettingsPage/index.tsx                ← new: standalone settings window
src/components/sessions/AudioPlayer.tsx         ← SessionAudioPlayer from App.tsx
src/components/sessions/ArtifactModal.tsx       ← new: artifact preview modal
src/components/sessions/DeleteConfirmModal.tsx  ← new: delete confirmation modal
src/components/sessions/SummaryPromptModal.tsx  ← new: summary prompt modal
src/components/sessions/SessionCard.tsx         ← new: single session card
src/components/sessions/SessionFilters.tsx      ← new: search toolbar
src/components/sessions/SessionList.tsx         ← new: list + empty state + modals
src/pages/MainPage/index.tsx                    ← new: main window
```

### Modified
```
src/App.tsx         → routing-only (replaces all existing content)
src/AppRoot.tsx     → uses appTheme from theme/index.ts, drops useGlassTheme
src/lib/appUtils.ts → add utility functions moved from App.tsx
```

### Deleted
```
src/appTypes.ts
src/status.ts
src/App.css
src/theme/useGlassTheme.ts
src/theme/glassTheme.module.css
src/features/         (entire directory)
```

---

### Task 1: Move types, lib/status, hooks

No logic changes — only moves and import updates.

**Files:**
- Create: `src/types/index.ts`
- Create: `src/lib/status.ts`
- Create: `src/hooks/useRecordingController.ts`
- Create: `src/hooks/useRecordingController.test.ts`
- Create: `src/hooks/useSessions.ts`
- Create: `src/hooks/useSessions.test.tsx`
- Create: `src/hooks/useSettingsForm.ts`
- Create: `src/hooks/useSettingsForm.test.tsx`

- [ ] **Step 1: Create `src/types/index.ts`**

Copy `src/appTypes.ts` content verbatim — same types, same exports, same constants. No changes to content.

```bash
cp src/appTypes.ts src/types/index.ts
```

- [ ] **Step 2: Create `src/lib/status.ts`**

```bash
cp src/status.ts src/lib/status.ts
```

- [ ] **Step 3: Create hook files and move trayAudio**

```bash
mkdir -p src/hooks src/components/tray src/components/sessions src/components/settings src/pages/TrayPage src/pages/SettingsPage src/pages/MainPage

cp src/features/recording/useRecordingController.ts src/hooks/useRecordingController.ts
cp src/features/recording/useRecordingController.test.tsx src/hooks/useRecordingController.test.ts
cp src/features/sessions/useSessions.ts src/hooks/useSessions.ts
cp src/features/sessions/useSessions.test.tsx src/hooks/useSessions.test.tsx
cp src/features/settings/useSettingsForm.ts src/hooks/useSettingsForm.ts
cp src/features/settings/useSettingsForm.test.tsx src/hooks/useSettingsForm.test.tsx
cp src/features/recording/trayAudio.ts src/lib/trayAudio.ts
cp src/features/recording/trayAudio.test.ts src/lib/trayAudio.test.ts
```

- [ ] **Step 4: Update imports in the moved hook files**

In `src/hooks/useRecordingController.ts` replace:
```ts
// old
import { ... } from "../../appTypes";
import { captureAnalyticsEvent } from "../../lib/analytics";
import { clamp01, parseEventPayload, splitTags } from "../../lib/appUtils";
import { tauriEmit, tauriInvoke, tauriListen } from "../../lib/tauri";
import { defaultRecordingMuteState, nextRecordingMuteState } from "./trayAudio";
```
```ts
// new
import { ... } from "../types";
import { captureAnalyticsEvent } from "../lib/analytics";
import { clamp01, parseEventPayload, splitTags } from "../lib/appUtils";
import { tauriEmit, tauriInvoke, tauriListen } from "../lib/tauri";
import { defaultRecordingMuteState, nextRecordingMuteState } from "../lib/trayAudio";
```

In `src/hooks/useRecordingController.test.ts` replace:
```ts
// old
vi.mock("../../lib/tauri", ...)
vi.mock("../../lib/analytics", ...)
import { StartResponse } from "../../appTypes";
import { shouldAnimateTrayAudio } from "./trayAudio";
import { useRecordingController } from "./useRecordingController";
```
```ts
// new
vi.mock("../lib/tauri", ...)
vi.mock("../lib/analytics", ...)
import { StartResponse } from "../types";
import { shouldAnimateTrayAudio } from "../lib/trayAudio";
import { useRecordingController } from "./useRecordingController";
```

In `src/lib/trayAudio.test.ts` no import path changes needed (file stays in `src/lib/`).

In `src/hooks/useSessions.ts` replace:
```ts
// old
import { ... } from "../../appTypes";
import { ... } from "../../lib/...";
```
```ts
// new
import { ... } from "../types";
import { ... } from "../lib/...";
```

Apply the same `../../` → `../` pattern to `useSettingsForm.ts` and both test files.

- [ ] **Step 5: Update `src/App.tsx` imports to use new paths**

In `src/App.tsx` replace all old import paths:
```ts
// old
import { ... } from "./appTypes";
import { TrayAudioRow } from "./features/recording/TrayAudioRow";
import { useRecordingController } from "./features/recording/useRecordingController";
import { useSessions } from "./features/sessions/useSessions";
import { useSettingsForm } from "./features/settings/useSettingsForm";
import { formatAppStatus, formatSessionStatus } from "./status";
```
```ts
// new
import { ... } from "./types";
import { TrayAudioRow } from "./features/recording/TrayAudioRow";  // still here for now
import { useRecordingController } from "./hooks/useRecordingController";
import { useSessions } from "./hooks/useSessions";
import { useSettingsForm } from "./hooks/useSettingsForm";
import { formatAppStatus, formatSessionStatus } from "./lib/status";
```

- [ ] **Step 6: Run tests to verify nothing is broken**

```bash
npm test
```

Expected: all tests pass (same as before this task — zero logic changed).

- [ ] **Step 7: Commit**

```bash
git add src/types/ src/lib/status.ts src/hooks/ src/App.tsx
git commit -m "refactor: scaffold types/, lib/status, hooks/ — no logic changes"
```

---

### Task 2: New theme + update AppRoot

Replace `useGlassTheme` with a simple `ThemeConfig`. Keep old CSS files until they are no longer imported (Task 6).

**Files:**
- Create: `src/theme/index.ts`
- Modify: `src/AppRoot.tsx`

- [ ] **Step 1: Create `src/theme/index.ts`**

```ts
import type { ThemeConfig } from "antd";

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: "#0056c8",
    colorError: "#b53434",
    borderRadius: 8,
    borderRadiusLG: 12,
    motionDurationSlow: "0.2s",
    motionDurationMid: "0.1s",
    motionDurationFast: "0.05s",
  },
};
```

- [ ] **Step 2: Update `src/AppRoot.tsx`**

```tsx
import AntdApp from "antd/es/app";
import ConfigProvider from "antd/es/config-provider";
import { App } from "./App";
import { appTheme } from "./theme";

export function AppRoot() {
  return (
    <ConfigProvider theme={appTheme}>
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  );
}
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/theme/index.ts src/AppRoot.tsx
git commit -m "refactor: replace useGlassTheme with simple ThemeConfig"
```

---

### Task 3: TrayPage

Extract the tray window render (App.tsx:1115–1273) into a proper page with components.

**Files:**
- Create: `src/components/tray/AudioWave.tsx`
- Create: `src/components/tray/AudioWave.test.tsx`
- Create: `src/components/tray/AudioRow.tsx`
- Create: `src/components/tray/RecordingControls.tsx`
- Create: `src/pages/TrayPage/index.tsx`
- Modify: `src/App.tsx` — remove tray render block, import TrayPage

- [ ] **Step 1: Create `src/components/tray/AudioWave.tsx`**

Copy `src/features/recording/TrayAudioWave.tsx` with updated import:
```tsx
// change only this import:
// old: import { buildTrayAudioWavePath, ... } from "./trayAudio";
// new:
import {
  buildTrayAudioWavePath,
  getTrayAudioWaveMetrics,
  TRAY_AUDIO_WAVE_VIEWBOX_HEIGHT,
  TRAY_AUDIO_WAVE_VIEWBOX_WIDTH,
} from "../../lib/trayAudio";
```

All other content identical to TrayAudioWave.tsx. The SVG uses CSS class names for stroke-width animation (`tray-audio-wave-path`, `tray-audio-wave-glow`, `tray-audio-wave-baseline`) which reference CSS custom properties — keep these class names and create a minimal CSS module:

Create `src/components/tray/AudioWave.module.css`:
```css
.wave { display: block; width: 100%; height: 100%; }
.baseline { stroke: currentColor; opacity: 0.2; fill: none; stroke-width: var(--tray-audio-wave-stroke-width, 1.5px); }
.glow { stroke: currentColor; opacity: 0.25; fill: none; stroke-width: var(--tray-audio-wave-stroke-width, 1.5px); filter: blur(2px); }
.path { stroke: currentColor; fill: none; stroke-width: var(--tray-audio-wave-stroke-width, 1.5px); }
```

In `AudioWave.tsx`, replace the CSS class names with CSS module classes:
```tsx
import styles from "./AudioWave.module.css";
// ...
<svg className={styles.wave} viewBox={...} preserveAspectRatio="none" aria-hidden="true">
  <path className={styles.baseline} d={flatPath} vectorEffect="non-scaling-stroke" />
  <path className={styles.glow} d={wavePath} vectorEffect="non-scaling-stroke"
    style={{ "--tray-audio-wave-stroke-width": `${metrics.strokeWidth + 1.2}px` } as CSSProperties} />
  <path className={styles.path} d={wavePath} vectorEffect="non-scaling-stroke"
    style={{ "--tray-audio-wave-stroke-width": `${metrics.strokeWidth}px` } as CSSProperties} />
</svg>
```

- [ ] **Step 2: Create `src/components/tray/AudioWave.test.tsx`**

Copy `src/features/recording/TrayAudioWave.test.tsx`, update imports:
```tsx
// old:
import { buildTrayAudioWavePath, getTrayAudioWaveMetrics } from "./trayAudio";
import { TrayAudioWave } from "./TrayAudioWave";
// new:
import { buildTrayAudioWavePath, getTrayAudioWaveMetrics } from "../../lib/trayAudio";
import { AudioWave } from "./AudioWave";
```

Update component name in the test body: `TrayAudioWave` → `AudioWave`. Update CSS class selector: `.tray-audio-wave-path` → query by `data-wave-mode` attribute or use `container.querySelector("path:last-child")` (the wave path is the last `<path>` element).

Actually to keep the test unchanged, add `data-testid="wave-path"` to the wave path element in `AudioWave.tsx`:
```tsx
<path data-testid="wave-path" className={styles.path} d={wavePath} ... />
```

And update the test:
```tsx
const renderedPath = container.querySelector("[data-testid='wave-path']")?.getAttribute("d");
```

- [ ] **Step 3: Run AudioWave test**

```bash
npm test -- AudioWave
```

Expected: PASS — "keeps animating while the input level changes"

- [ ] **Step 4: Create `src/components/tray/AudioRow.tsx`**

Replace CSS classNames with Ant Design layout. Props interface is identical to `TrayAudioRow`:

```tsx
import { type ReactNode } from "react";
import { Button, Flex, Typography } from "antd";
import { AudioWave } from "./AudioWave";

type AudioRowProps = {
  label: string;
  animationLabel: string;
  muteLabel: string;
  icon: "mic" | "system";
  level: number;
  muted: boolean;
  disabled: boolean;
  onToggleMuted: () => void;
  statusText?: string | null;
  trailing?: ReactNode;
  inlineTrailing?: boolean;
};

function AudioIcon({ icon }: { icon: "mic" | "system" }) {
  // identical SVG content from TrayAudioRow — copy TrayAudioIcon function body
}

export function AudioRow({
  label, animationLabel, muteLabel, icon, level, muted,
  disabled, onToggleMuted, statusText, trailing, inlineTrailing = false,
}: AudioRowProps) {
  const buttonLabel = muted ? `Unmute ${muteLabel}` : `Mute ${muteLabel}`;

  return (
    <Flex align="center" gap={6} style={{ minHeight: 36 }}>
      <Typography.Text style={{ width: 48, flexShrink: 0, fontSize: 13 }}>
        {label}
      </Typography.Text>
      <Flex flex={1} align="center" gap={6} style={{ minWidth: 0 }}>
        {statusText ? (
          <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
            {statusText}
          </Typography.Text>
        ) : (
          <div style={{ flex: 1, height: 28 }} aria-label={animationLabel}>
            <AudioWave level={level} muted={muted} />
          </div>
        )}
        {trailing && (
          <div style={inlineTrailing ? { flexShrink: 0 } : { width: "100%", marginTop: 4 }}>
            {trailing}
          </div>
        )}
      </Flex>
      <Button
        htmlType="button"
        type={muted ? "default" : "text"}
        aria-label={buttonLabel}
        aria-pressed={muted}
        disabled={disabled}
        onClick={onToggleMuted}
        style={{ position: "relative", width: 32, height: 32, padding: 0 }}
      >
        <span style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <AudioIcon icon={icon} />
          {muted && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              {/* diagonal slash line */}
              <svg viewBox="0 0 20 20" width={20} height={20} aria-hidden="true">
                <line x1="4" y1="4" x2="16" y2="16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </span>
          )}
        </span>
      </Button>
    </Flex>
  );
}
```

- [ ] **Step 5: Create `src/components/tray/RecordingControls.tsx`**

Source/Topic inputs for the tray window:

```tsx
import { Flex } from "antd";
import { Input, Select } from "antd";
import { fixedSources } from "../../types";

type RecordingControlsProps = {
  source: string;
  topic: string;
  isRecording: boolean;
  onSourceChange: (value: string) => void;
  onTopicChange: (value: string) => void;
};

export function RecordingControls({
  source, topic, isRecording, onSourceChange, onTopicChange,
}: RecordingControlsProps) {
  const fixedSourceOptions = fixedSources.map((s) => ({ value: s, label: s }));

  return (
    <Flex gap={8}>
      <Flex vertical gap={2} style={{ flex: "0 0 auto", minWidth: 100 }}>
        <label htmlFor="tray-source" style={{ fontSize: 12 }}>Source</label>
        <Select
          id="tray-source"
          aria-label="Source"
          size="small"
          value={source}
          options={fixedSourceOptions}
          onChange={onSourceChange}
          disabled={isRecording}
        />
      </Flex>
      <Flex vertical gap={2} style={{ flex: 1 }}>
        <label htmlFor="tray-topic" style={{ fontSize: 12 }}>Topic (optional)</label>
        <Input
          id="tray-topic"
          aria-label="Topic (optional)"
          size="small"
          value={topic}
          onChange={(e) => onTopicChange(e.target.value)}
          disabled={isRecording}
        />
      </Flex>
    </Flex>
  );
}
```

- [ ] **Step 6: Create `src/pages/TrayPage/index.tsx`**

Move tray render logic from App.tsx:1115–1273 into this component. The component calls its own hooks (each Tauri window is a separate React root).

```tsx
import { useState } from "react";
import { Alert, Button, Flex, Typography } from "antd";
import { useRecordingController } from "../../hooks/useRecordingController";
import { useSettingsForm } from "../../hooks/useSettingsForm";
import { StartResponse } from "../../types";
import { formatAppStatus } from "../../lib/status";
import { getErrorMessage } from "../../lib/appUtils";
import { AudioRow } from "../../components/tray/AudioRow";
import { RecordingControls } from "../../components/tray/RecordingControls";
import { Select } from "antd";

export function TrayPage() {
  const [status, setStatus] = useState("idle");
  const [topic, setTopic] = useState("");
  const [source, setSource] = useState("slack");
  const [session, setSession] = useState<StartResponse | null>(null);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const [trayMuteError, setTrayMuteError] = useState<string | null>(null);

  const {
    audioDevices,
    macosSystemAudioPermission,
    macosSystemAudioPermissionLoadState,
    openMacosSystemAudioSettings,
    saveSettingsPatch,
    settings,
  } = useSettingsForm({ enabled: true, isTrayWindow: true, setStatus });

  const { liveLevels, muteState, startFromTray, stop, toggleInputMuted } = useRecordingController({
    enableTrayCommandListeners: false,
    isSettingsWindow: false,
    isTrayWindow: true,
    topic,
    setTopic,
    tagsInput: "",
    source,
    setSource,
    notesInput: "",
    session,
    setSession,
    lastSessionId,
    setLastSessionId,
    status,
    setStatus,
    loadSessions: async () => {},
  });

  // Permission-derived booleans (same logic as App.tsx:1116–1125)
  const isMacosSystemAudioUnsupported =
    macosSystemAudioPermissionLoadState === "ready" &&
    macosSystemAudioPermission?.kind === "unsupported";
  const isMacosSystemAudioLoading = macosSystemAudioPermissionLoadState === "loading";
  const isMacosSystemAudioLookupFailed = macosSystemAudioPermissionLoadState === "error";
  const isMacosSystemAudioPermissionPendingReview =
    macosSystemAudioPermissionLoadState === "ready" &&
    macosSystemAudioPermission?.kind !== "granted" &&
    macosSystemAudioPermission?.kind !== "unsupported";
  const showMacosSystemAudioSettingsShortcut =
    isMacosSystemAudioPermissionPendingReview || isMacosSystemAudioLookupFailed;

  const isRecording = status === "recording";

  async function handleToggleMuted(channel: "mic" | "system") {
    setTrayMuteError(null);
    try {
      await toggleInputMuted(channel);
    } catch (err) {
      setTrayMuteError(`Mute update failed: ${getErrorMessage(err)}`);
    }
  }

  async function handleStart() {
    setTrayMuteError(null);
    await startFromTray();
  }

  async function handleStop() {
    setTrayMuteError(null);
    await stop();
  }

  return (
    <Flex
      vertical
      gap={8}
      style={{ height: "100vh", padding: "10px 12px", boxSizing: "border-box" }}
    >
      {/* Status bar */}
      <Flex justify="space-between" align="center">
        <Typography.Text style={{ fontSize: 12 }}>
          Status: {formatAppStatus(status)}
        </Typography.Text>
        {showMacosSystemAudioSettingsShortcut && (
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            onClick={() => void openMacosSystemAudioSettings()}
          >
            Open System Settings
          </Button>
        )}
      </Flex>

      {trayMuteError && (
        <Alert type="error" message={trayMuteError} banner style={{ fontSize: 12 }} />
      )}

      {/* Source + Topic */}
      <RecordingControls
        source={source}
        topic={topic}
        isRecording={isRecording}
        onSourceChange={setSource}
        onTopicChange={setTopic}
      />

      {/* Mic row */}
      <AudioRow
        label="Mic"
        animationLabel="Mic activity"
        muteLabel="microphone"
        icon="mic"
        level={liveLevels.mic}
        muted={muteState.micMuted}
        disabled={!isRecording}
        onToggleMuted={() => void handleToggleMuted("mic")}
        inlineTrailing
        trailing={
          <label>
            <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>
              Mic device
            </span>
            <Select
              aria-label="Mic device"
              size="small"
              value={settings?.mic_device_name ?? ""}
              options={[
                { value: "", label: "Auto" },
                ...audioDevices.map((dev) => ({ value: dev, label: dev })),
              ]}
              onChange={(value) => {
                void saveSettingsPatch({ mic_device_name: value }).catch((err) =>
                  setStatus(`error: ${String(err)}`)
                );
              }}
              disabled={isRecording}
            />
          </label>
        }
      />

      {/* System row */}
      <AudioRow
        label="System"
        animationLabel="System activity"
        muteLabel="system audio"
        icon="system"
        level={liveLevels.system}
        muted={muteState.systemMuted}
        disabled={
          !isRecording ||
          isMacosSystemAudioLoading ||
          isMacosSystemAudioLookupFailed ||
          isMacosSystemAudioPermissionPendingReview
        }
        onToggleMuted={() => void handleToggleMuted("system")}
        statusText={
          isMacosSystemAudioLoading
            ? "Checking macOS system audio status"
            : isMacosSystemAudioLookupFailed
              ? "Could not load macOS system audio status. Open System Settings to review the permission."
              : isMacosSystemAudioPermissionPendingReview
                ? "Grant Screen & System Audio Recording permission in System Settings."
                : null
        }
        inlineTrailing
        trailing={
          isMacosSystemAudioUnsupported ? (
            <label>
              <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>
                System device
              </span>
              <Select
                aria-label="System device"
                size="small"
                value={settings?.system_device_name ?? ""}
                options={[
                  { value: "", label: "Auto" },
                  ...audioDevices.map((dev) => ({ value: dev, label: dev })),
                ]}
                onChange={(value) => {
                  void saveSettingsPatch({ system_device_name: value }).catch((err) =>
                    setStatus(`error: ${String(err)}`)
                  );
                }}
                disabled={isRecording}
              />
            </label>
          ) : null
        }
      />

      {/* Rec / Stop */}
      <Flex gap={8} style={{ marginTop: "auto" }}>
        <Button
          type="primary"
          onClick={() => void handleStart()}
          disabled={isRecording}
          style={{ flex: 1 }}
        >
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "currentColor",
              marginRight: 6,
              opacity: isRecording ? 0.4 : 1,
            }}
          />
          Rec
        </Button>
        <Button
          onClick={() => void handleStop()}
          disabled={!isRecording}
          style={{ flex: 1 }}
        >
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              background: "currentColor",
              marginRight: 6,
              opacity: !isRecording ? 0.4 : 1,
            }}
          />
          Stop
        </Button>
      </Flex>
    </Flex>
  );
}
```

- [ ] **Step 7: Update `src/App.tsx` to use TrayPage**

Add import at top of App.tsx:
```tsx
import { TrayPage } from "./pages/TrayPage";
```

Replace the tray window block (App.tsx:1115–1274 — the `if (isTrayWindow) { ... return ... }` block) with:
```tsx
if (isTrayWindow) {
  return <TrayPage />;
}
```

The tray window no longer needs `topic`, `source`, `session`, `lastSessionId`, `trayMuteError`, etc. in the main App component. However, these are still used by `useRecordingController` in the main window context, so leave the hook calls as-is for now. They will be cleaned up in Task 5 when App.tsx is fully replaced.

- [ ] **Step 8: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/components/tray/ src/pages/TrayPage/ src/App.tsx
git commit -m "refactor: extract TrayPage and tray components"
```

---

### Task 4: SettingsPage

Extract the settings rendering (App.tsx `renderSettingsFields()`) into focused components.

**Files:**
- Modify: `src/lib/appUtils.ts` — add `localIconForEditor`, `openerUiFallback`
- Create: `src/components/settings/GeneralSettings.tsx`
- Create: `src/components/settings/TranscriptionSettings.tsx`
- Create: `src/components/settings/AudioSettings.tsx`
- Create: `src/pages/SettingsPage/index.tsx`
- Modify: `src/App.tsx` — remove settings window block, import SettingsPage

- [ ] **Step 1: Move `localIconForEditor` and `openerUiFallback` to `src/lib/appUtils.ts`**

Add at the end of `src/lib/appUtils.ts`:

```ts
import vscodeIcon from "../assets/editor-icons/vscode.svg";
import cursorIcon from "../assets/editor-icons/cursor.svg";
import sublimeIcon from "../assets/editor-icons/sublime.svg";
import type { TextEditorAppOption } from "../types";

export function localIconForEditor(editorName: string): string | null {
  const lowered = editorName.toLowerCase();
  if (lowered.includes("visual studio code") || lowered === "vscode") return vscodeIcon;
  if (lowered.includes("cursor")) return cursorIcon;
  if (lowered.includes("sublime")) return sublimeIcon;
  return null;
}

export const openerUiFallback: TextEditorAppOption[] = [
  { id: "TextEdit", name: "TextEdit", icon_fallback: "📝", icon_data_url: null },
  { id: "Visual Studio Code", name: "Visual Studio Code", icon_fallback: "💠", icon_data_url: null },
  { id: "Sublime Text", name: "Sublime Text", icon_fallback: "🟧", icon_data_url: null },
  { id: "Cursor", name: "Cursor", icon_fallback: "🧩", icon_data_url: null },
  { id: "Windsurf", name: "Windsurf", icon_fallback: "🧩", icon_data_url: null },
  { id: "Zed", name: "Zed", icon_fallback: "🧩", icon_data_url: null },
];
```

- [ ] **Step 2: Create `src/components/settings/GeneralSettings.tsx`**

Contains the "Generals" tab content (from App.tsx:901–978):

```tsx
import { Button, Flex, Form, Input, Select, Switch } from "antd";
import type { PublicSettings, TextEditorAppOption } from "../../types";
import { localIconForEditor } from "../../lib/appUtils";

type GeneralSettingsProps = {
  settings: PublicSettings;
  setSettings: (s: PublicSettings) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
  pickRecordingRoot: () => void;
  textEditorApps: TextEditorAppOption[];
};

export function GeneralSettings({
  settings, setSettings, isDirty, pickRecordingRoot, textEditorApps,
}: GeneralSettingsProps) {
  const openerUiFallback: TextEditorAppOption[] = [
    { id: "TextEdit", name: "TextEdit", icon_fallback: "📝", icon_data_url: null },
    { id: "Visual Studio Code", name: "Visual Studio Code", icon_fallback: "💠", icon_data_url: null },
    { id: "Sublime Text", name: "Sublime Text", icon_fallback: "🟧", icon_data_url: null },
    { id: "Cursor", name: "Cursor", icon_fallback: "🧩", icon_data_url: null },
    { id: "Windsurf", name: "Windsurf", icon_fallback: "🧩", icon_data_url: null },
    { id: "Zed", name: "Zed", icon_fallback: "🧩", icon_data_url: null },
  ];
  const openerOptions = textEditorApps.length > 0 ? textEditorApps : openerUiFallback;
  const openerMenuOptions = [
    { id: "", name: "System default", icon_fallback: "", icon_data_url: null },
    ...openerOptions,
  ];

  return (
    <Form layout="vertical">
      <Form.Item
        label="Recording root"
        style={isDirty("recording_root") ? { fontWeight: 600 } : undefined}
      >
        <Flex gap={8}>
          <Input
            value={settings.recording_root}
            onChange={(e) => setSettings({ ...settings, recording_root: e.target.value })}
          />
          <Button
            htmlType="button"
            aria-label="Choose recording root folder"
            onClick={pickRecordingRoot}
            icon={
              <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true">
                <path
                  d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h3.1a2.25 2.25 0 0 1 1.59.66l.84.84h6.47a2.25 2.25 0 0 1 2.25 2.25v7.5A2.25 2.25 0 0 1 18 18H6a2.25 2.25 0 0 1-2.25-2.25v-6a3 3 0 0 1 0-3Z"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                />
              </svg>
            }
          />
        </Flex>
      </Form.Item>

      <Form.Item
        label="Artifact opener app (optional)"
        style={isDirty("artifact_open_app") ? { fontWeight: 600 } : undefined}
      >
        <Select
          aria-label="Artifact opener app"
          value={settings.artifact_open_app}
          virtual={false}
          options={openerMenuOptions.map((editor) => ({
            value: editor.id,
            label: (
              <Flex align="center" gap={6}>
                {editor.id && (editor.icon_data_url || localIconForEditor(editor.name)) ? (
                  <img
                    src={editor.icon_data_url || localIconForEditor(editor.name) || ""}
                    alt=""
                    aria-hidden="true"
                    style={{ width: 14, height: 14 }}
                  />
                ) : editor.id ? (
                  <span aria-hidden="true">{editor.icon_fallback}</span>
                ) : null}
                <span>{editor.name}</span>
              </Flex>
            ),
          }))}
          onChange={(value) => setSettings({ ...settings, artifact_open_app: value })}
        />
      </Form.Item>

      <Form.Item
        label="Auto-run pipeline on Stop"
        style={isDirty("auto_run_pipeline_on_stop") ? { fontWeight: 600 } : undefined}
      >
        <Switch
          aria-label="Auto-run pipeline on Stop"
          checked={Boolean(settings.auto_run_pipeline_on_stop)}
          onChange={(checked) => setSettings({ ...settings, auto_run_pipeline_on_stop: checked })}
        />
      </Form.Item>

      <Form.Item
        label="Enable API call logging"
        style={isDirty("api_call_logging_enabled") ? { fontWeight: 600 } : undefined}
      >
        <Switch
          aria-label="Enable API call logging"
          checked={Boolean(settings.api_call_logging_enabled)}
          onChange={(checked) => setSettings({ ...settings, api_call_logging_enabled: checked })}
        />
      </Form.Item>
    </Form>
  );
}
```

- [ ] **Step 3: Create `src/components/settings/TranscriptionSettings.tsx`**

Contains both Transcription and Summary sections from App.tsx:736–897:

```tsx
import { Form, Input, InputNumber, Select, Typography } from "antd";
import type { PublicSettings, SecretSaveState } from "../../types";
import {
  diarizationSettingOptions,
  saluteSpeechRecognitionModelOptions,
  saluteSpeechScopeOptions,
  transcriptionProviderOptions,
  transcriptionTaskOptions,
} from "../../types";
import { formatSecretSaveState } from "../../lib/appUtils";

type TranscriptionSettingsProps = {
  settings: PublicSettings;
  setSettings: (s: PublicSettings) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
  nexaraKey: string;
  setNexaraKey: (v: string) => void;
  nexaraSecretState: SecretSaveState;
  setNexaraSecretState: (v: SecretSaveState) => void;
  salutSpeechAuthKey: string;
  setSalutSpeechAuthKey: (v: string) => void;
  salutSpeechSecretState: SecretSaveState;
  setSalutSpeechSecretState: (v: SecretSaveState) => void;
  openaiKey: string;
  setOpenaiKey: (v: string) => void;
  openaiSecretState: SecretSaveState;
  setOpenaiSecretState: (v: SecretSaveState) => void;
};

export function TranscriptionSettings({
  settings, setSettings, isDirty,
  nexaraKey, setNexaraKey, nexaraSecretState, setNexaraSecretState,
  salutSpeechAuthKey, setSalutSpeechAuthKey, salutSpeechSecretState, setSalutSpeechSecretState,
  openaiKey, setOpenaiKey, openaiSecretState, setOpenaiSecretState,
}: TranscriptionSettingsProps) {
  const isNexaraProvider = settings.transcription_provider === "nexara";

  return (
    <Form layout="vertical">
      {/* Transcription section */}
      <Typography.Title level={5}>Транскрибация</Typography.Title>

      <Form.Item label="Transcription provider" style={isDirty("transcription_provider") ? { fontWeight: 600 } : undefined}>
        <Select
          aria-label="Transcription provider"
          value={settings.transcription_provider}
          options={transcriptionProviderOptions.map((value) => ({
            value,
            label: value === "nexara" ? "nexara" : "SalutSpeechAPI",
          }))}
          onChange={(value) => setSettings({ ...settings, transcription_provider: value })}
        />
      </Form.Item>

      {isNexaraProvider ? (
        <>
          <Form.Item label="Transcription URL" style={isDirty("transcription_url") ? { fontWeight: 600 } : undefined}>
            <Input
              value={settings.transcription_url}
              onChange={(e) => setSettings({ ...settings, transcription_url: e.target.value })}
            />
          </Form.Item>
          <Form.Item label="Task" style={isDirty("transcription_task") ? { fontWeight: 600 } : undefined}>
            <Select
              aria-label="Task"
              value={settings.transcription_task}
              options={transcriptionTaskOptions.map((value) => ({ value, label: value }))}
              onChange={(value) => setSettings({ ...settings, transcription_task: value })}
            />
          </Form.Item>
          <Form.Item label="Diarization setting" style={isDirty("transcription_diarization_setting") ? { fontWeight: 600 } : undefined}>
            <Select
              aria-label="Diarization setting"
              value={settings.transcription_diarization_setting}
              options={diarizationSettingOptions.map((value) => ({ value, label: value }))}
              onChange={(value) => setSettings({ ...settings, transcription_diarization_setting: value })}
            />
          </Form.Item>
          <Form.Item label="Nexara API key">
            <Input.Password
              value={nexaraKey}
              onChange={(e) => { setNexaraKey(e.target.value); setNexaraSecretState("unknown"); }}
              placeholder="Stored in OS secure storage"
            />
            {nexaraSecretState !== "unknown" && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatSecretSaveState(nexaraSecretState)}
              </Typography.Text>
            )}
          </Form.Item>
        </>
      ) : (
        <>
          <Form.Item label="Scope" style={isDirty("salute_speech_scope") ? { fontWeight: 600 } : undefined}>
            <Select
              aria-label="Scope"
              value={settings.salute_speech_scope}
              virtual={false}
              options={saluteSpeechScopeOptions.map((value) => ({ value, label: value }))}
              onChange={(value) => setSettings({ ...settings, salute_speech_scope: value })}
            />
          </Form.Item>
          <Form.Item label="Recognition model" style={isDirty("salute_speech_model") ? { fontWeight: 600 } : undefined}>
            <Select
              aria-label="Recognition model"
              value={settings.salute_speech_model}
              virtual={false}
              options={saluteSpeechRecognitionModelOptions.map((value) => ({ value, label: value }))}
              onChange={(value) => setSettings({ ...settings, salute_speech_model: value })}
            />
          </Form.Item>
          <Form.Item label="Language" style={isDirty("salute_speech_language") ? { fontWeight: 600 } : undefined}>
            <Input
              value={settings.salute_speech_language}
              onChange={(e) => setSettings({ ...settings, salute_speech_language: e.target.value })}
            />
          </Form.Item>
          <Form.Item label="Sample rate" style={isDirty("salute_speech_sample_rate") ? { fontWeight: 600 } : undefined}>
            <InputNumber
              aria-label="Sample rate"
              value={settings.salute_speech_sample_rate}
              onChange={(value) => setSettings({ ...settings, salute_speech_sample_rate: Number(value) || 0 })}
            />
          </Form.Item>
          <Form.Item label="Channels count" style={isDirty("salute_speech_channels_count") ? { fontWeight: 600 } : undefined}>
            <InputNumber
              aria-label="Channels count"
              value={settings.salute_speech_channels_count}
              onChange={(value) => setSettings({ ...settings, salute_speech_channels_count: Number(value) || 0 })}
            />
          </Form.Item>
          <Form.Item label="SalutSpeech authorization key">
            <Input.Password
              value={salutSpeechAuthKey}
              onChange={(e) => { setSalutSpeechAuthKey(e.target.value); setSalutSpeechSecretState("unknown"); }}
              placeholder="Stored in OS secure storage"
            />
            {salutSpeechSecretState !== "unknown" && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatSecretSaveState(salutSpeechSecretState)}
              </Typography.Text>
            )}
          </Form.Item>
        </>
      )}

      {/* Summary section */}
      <Typography.Title level={5}>Саммари</Typography.Title>
      <Form.Item label="Summary URL" style={isDirty("summary_url") ? { fontWeight: 600 } : undefined}>
        <Input
          value={settings.summary_url}
          onChange={(e) => setSettings({ ...settings, summary_url: e.target.value })}
        />
      </Form.Item>
      <Form.Item label="Summary prompt" style={isDirty("summary_prompt") ? { fontWeight: 600 } : undefined}>
        <Input.TextArea
          value={settings.summary_prompt}
          onChange={(e) => setSettings({ ...settings, summary_prompt: e.target.value })}
          rows={4}
        />
      </Form.Item>
      <Form.Item label="OpenAI model" style={isDirty("openai_model") ? { fontWeight: 600 } : undefined}>
        <Input
          value={settings.openai_model}
          onChange={(e) => setSettings({ ...settings, openai_model: e.target.value })}
        />
      </Form.Item>
      <Form.Item label="OpenAI API key">
        <Input.Password
          value={openaiKey}
          onChange={(e) => { setOpenaiKey(e.target.value); setOpenaiSecretState("unknown"); }}
          placeholder="Stored in OS secure storage"
        />
        {openaiSecretState !== "unknown" && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatSecretSaveState(openaiSecretState)}
          </Typography.Text>
        )}
      </Form.Item>
    </Form>
  );
}
```

- [ ] **Step 4: Create `src/components/settings/AudioSettings.tsx`**

Contains the Audio tab content (App.tsx:981–1088):

```tsx
import { Button, Card, Flex, Form, Input, InputNumber, Select, Typography } from "antd";
import type { MacosSystemAudioPermissionStatus, PublicSettings } from "../../types";
import { audioFormatOptions } from "../../types";

type AudioSettingsProps = {
  settings: PublicSettings;
  setSettings: (s: PublicSettings | ((prev: PublicSettings | null) => PublicSettings | null)) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
  audioDevices: string[];
  autoDetectSystemSource: () => void;
  macosSystemAudioPermission: MacosSystemAudioPermissionStatus | null;
  macosSystemAudioPermissionLoadState: string;
  openMacosSystemAudioSettings: () => Promise<void>;
};

export function AudioSettings({
  settings, setSettings, isDirty, audioDevices, autoDetectSystemSource,
  macosSystemAudioPermission, macosSystemAudioPermissionLoadState, openMacosSystemAudioSettings,
}: AudioSettingsProps) {
  const isOpusFormat = settings.audio_format === "opus";
  const isMacosPermissionLoading = macosSystemAudioPermissionLoadState === "loading";
  const isMacosPermissionLookupFailed = macosSystemAudioPermissionLoadState === "error";
  const isMacosPermissionUnsupported =
    macosSystemAudioPermissionLoadState === "ready" &&
    macosSystemAudioPermission?.kind === "unsupported";

  return (
    <Form layout="vertical">
      <Form.Item label="Audio format" style={isDirty("audio_format") ? { fontWeight: 600 } : undefined}>
        <Select
          aria-label="Audio format"
          value={settings.audio_format}
          options={audioFormatOptions.map((value) => ({ value, label: value }))}
          onChange={(value) => setSettings({ ...settings, audio_format: value })}
        />
      </Form.Item>
      <Form.Item label="Opus bitrate kbps" style={isDirty("opus_bitrate_kbps") ? { fontWeight: 600 } : undefined}>
        <InputNumber
          aria-label="Opus bitrate kbps"
          value={settings.opus_bitrate_kbps}
          disabled={!isOpusFormat}
          onChange={(value) => setSettings({ ...settings, opus_bitrate_kbps: Number(value) || 24 })}
        />
      </Form.Item>
      <Form.Item label="Mic device name" style={isDirty("mic_device_name") ? { fontWeight: 600 } : undefined}>
        <Input
          value={settings.mic_device_name}
          onChange={(e) => setSettings({ ...settings, mic_device_name: e.target.value })}
        />
      </Form.Item>

      {isMacosPermissionLoading ? (
        <Card size="small">
          <Typography.Text strong>Checking macOS permission status</Typography.Text>
          <br />
          <Typography.Text type="secondary">
            Native system audio controls will appear once the status is available.
          </Typography.Text>
        </Card>
      ) : isMacosPermissionUnsupported ? (
        <>
          <Form.Item label="System source device name" style={isDirty("system_device_name") ? { fontWeight: 600 } : undefined}>
            <Input
              value={settings.system_device_name}
              onChange={(e) => setSettings({ ...settings, system_device_name: e.target.value })}
            />
          </Form.Item>
          <Form.Item>
            <Button onClick={autoDetectSystemSource}>Auto-detect system source</Button>
          </Form.Item>
          {audioDevices.length > 0 && (
            <Card size="small" title="Available input devices">
              <Flex gap={8} wrap="wrap">
                {audioDevices.map((dev) => (
                  <Button
                    key={dev}
                    htmlType="button"
                    size="small"
                    onClick={() =>
                      setSettings((prev) =>
                        prev
                          ? {
                              ...prev,
                              mic_device_name: prev.mic_device_name || dev,
                              system_device_name: prev.system_device_name || dev,
                            }
                          : prev
                      )
                    }
                  >
                    {dev}
                  </Button>
                ))}
              </Flex>
            </Card>
          )}
        </>
      ) : (
        <Card size="small">
          {macosSystemAudioPermission?.kind === "granted" ? (
            <>
              <Typography.Text strong>Permission granted</Typography.Text>
              <br />
              <Typography.Text type="secondary">System audio is captured natively by macOS.</Typography.Text>
            </>
          ) : isMacosPermissionLookupFailed ? (
            <>
              <Typography.Text strong>System audio is captured natively by macOS</Typography.Text>
              <br />
              <Typography.Text type="secondary">
                Could not load permission status. Open System Settings to review Screen &amp; System Audio Recording permission.
              </Typography.Text>
              <br />
              <Button style={{ marginTop: 8 }} onClick={() => void openMacosSystemAudioSettings()}>
                Open System Settings
              </Button>
            </>
          ) : (
            <>
              <Typography.Text strong>System audio is captured natively by macOS</Typography.Text>
              <br />
              <Typography.Text type="secondary">
                Grant Screen &amp; System Audio Recording permission in System Settings.
              </Typography.Text>
              <br />
              <Button style={{ marginTop: 8 }} onClick={() => void openMacosSystemAudioSettings()}>
                Open System Settings
              </Button>
            </>
          )}
        </Card>
      )}
    </Form>
  );
}
```

- [ ] **Step 5: Create `src/pages/SettingsPage/index.tsx`**

Calls `useSettingsForm` and renders tabs + sub-components. The dirty dot is shown in the tab label.

```tsx
import { useState } from "react";
import { Alert, Button, Flex, Tabs } from "antd";
import { useSettingsForm } from "../../hooks/useSettingsForm";
import type { PublicSettings, SettingsTab } from "../../types";
import { GeneralSettings } from "../../components/settings/GeneralSettings";
import { TranscriptionSettings } from "../../components/settings/TranscriptionSettings";
import { AudioSettings } from "../../components/settings/AudioSettings";

export function SettingsPage() {
  const [status, setStatus] = useState("idle");

  const {
    audioDevices,
    autoDetectSystemSource,
    canSaveSettings,
    macosSystemAudioPermission,
    macosSystemAudioPermissionLoadState,
    nexaraKey,
    nexaraSecretState,
    openaiKey,
    openaiSecretState,
    openMacosSystemAudioSettings,
    pickRecordingRoot,
    salutSpeechAuthKey,
    salutSpeechSecretState,
    saveApiKeys,
    saveSettings,
    savedSettingsSnapshot,
    setNexaraKey,
    setNexaraSecretState,
    setOpenaiKey,
    setOpenaiSecretState,
    setSalutSpeechAuthKey,
    setSalutSpeechSecretState,
    setSettings,
    setSettingsTab,
    settings,
    settingsErrors,
    settingsTab,
    textEditorApps,
  } = useSettingsForm({ enabled: true, isTrayWindow: false, setStatus });

  if (!settings) return null;

  const isDirty = (field: keyof PublicSettings) =>
    Boolean(savedSettingsSnapshot && settings[field] !== savedSettingsSnapshot[field]);

  const dirtyByTab: Record<SettingsTab, boolean> = {
    audiototext:
      isDirty("transcription_provider") ||
      isDirty("transcription_url") ||
      isDirty("transcription_task") ||
      isDirty("transcription_diarization_setting") ||
      isDirty("salute_speech_scope") ||
      isDirty("salute_speech_model") ||
      isDirty("salute_speech_language") ||
      isDirty("salute_speech_sample_rate") ||
      isDirty("salute_speech_channels_count") ||
      isDirty("summary_url") ||
      isDirty("summary_prompt") ||
      isDirty("openai_model") ||
      nexaraKey.trim().length > 0 ||
      salutSpeechAuthKey.trim().length > 0 ||
      openaiKey.trim().length > 0,
    generals:
      isDirty("recording_root") ||
      isDirty("artifact_open_app") ||
      isDirty("auto_run_pipeline_on_stop") ||
      isDirty("api_call_logging_enabled"),
    audio:
      isDirty("audio_format") ||
      isDirty("opus_bitrate_kbps") ||
      isDirty("mic_device_name") ||
      isDirty("system_device_name"),
  };

  const tabLabel = (id: SettingsTab, label: string) => (
    <span>
      {label}
      {dirtyByTab[id] && (
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#0056c8",
            marginLeft: 5,
            verticalAlign: "middle",
          }}
        />
      )}
    </span>
  );

  const tabItems = [
    {
      key: "generals" as SettingsTab,
      label: tabLabel("generals", "Generals"),
      children: (
        <GeneralSettings
          settings={settings}
          setSettings={setSettings}
          isDirty={isDirty}
          pickRecordingRoot={pickRecordingRoot}
          textEditorApps={textEditorApps}
        />
      ),
    },
    {
      key: "audiototext" as SettingsTab,
      label: tabLabel("audiototext", "AudioToText"),
      children: (
        <TranscriptionSettings
          settings={settings}
          setSettings={setSettings}
          isDirty={isDirty}
          nexaraKey={nexaraKey}
          setNexaraKey={setNexaraKey}
          nexaraSecretState={nexaraSecretState}
          setNexaraSecretState={setNexaraSecretState}
          salutSpeechAuthKey={salutSpeechAuthKey}
          setSalutSpeechAuthKey={setSalutSpeechAuthKey}
          salutSpeechSecretState={salutSpeechSecretState}
          setSalutSpeechSecretState={setSalutSpeechSecretState}
          openaiKey={openaiKey}
          setOpenaiKey={setOpenaiKey}
          openaiSecretState={openaiSecretState}
          setOpenaiSecretState={setOpenaiSecretState}
        />
      ),
    },
    {
      key: "audio" as SettingsTab,
      label: tabLabel("audio", "Audio"),
      children: (
        <AudioSettings
          settings={settings}
          setSettings={setSettings}
          isDirty={isDirty}
          audioDevices={audioDevices}
          autoDetectSystemSource={autoDetectSystemSource}
          macosSystemAudioPermission={macosSystemAudioPermission}
          macosSystemAudioPermissionLoadState={macosSystemAudioPermissionLoadState}
          openMacosSystemAudioSettings={openMacosSystemAudioSettings}
        />
      ),
    },
  ];

  return (
    <Flex
      vertical
      style={{ padding: 20, overflowY: "auto", boxSizing: "border-box" }}
    >
      <Tabs
        activeKey={settingsTab}
        items={tabItems}
        onChange={(key) => setSettingsTab(key as SettingsTab)}
      />

      {settingsErrors.length > 0 && (
        <Alert
          type="error"
          message={settingsErrors.join(", ")}
          style={{ marginBottom: 12 }}
        />
      )}

      <Flex gap={8}>
        <Button type="primary" onClick={saveSettings} disabled={!canSaveSettings}>
          Save settings
        </Button>
        <Button onClick={saveApiKeys}>Save API keys</Button>
      </Flex>
    </Flex>
  );
}
```

- [ ] **Step 6: Update `src/App.tsx` to use SettingsPage**

Add import:
```tsx
import { SettingsPage } from "./pages/SettingsPage";
```

Replace the settings window block (App.tsx:1276–1284 — `if (isSettingsWindow) { return ... }`) with:
```tsx
if (isSettingsWindow) {
  return <SettingsPage />;
}
```

- [ ] **Step 7: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/ src/pages/SettingsPage/ src/lib/appUtils.ts src/App.tsx
git commit -m "refactor: extract SettingsPage and settings components"
```

---

### Task 5: MainPage + slim App.tsx

Extract the main window render (App.tsx:1286–1772) and replace App.tsx with the routing-only version.

**Files:**
- Modify: `src/lib/appUtils.ts` — add utility functions from App.tsx
- Create: `src/components/sessions/AudioPlayer.tsx`
- Create: `src/components/sessions/ArtifactModal.tsx`
- Create: `src/components/sessions/DeleteConfirmModal.tsx`
- Create: `src/components/sessions/SummaryPromptModal.tsx`
- Create: `src/components/sessions/SessionCard.tsx`
- Create: `src/components/sessions/SessionFilters.tsx`
- Create: `src/components/sessions/SessionList.tsx`
- Create: `src/pages/MainPage/index.tsx`
- Replace: `src/App.tsx` — routing only

- [ ] **Step 1: Add utility functions to `src/lib/appUtils.ts`**

Add the following functions (copied verbatim from App.tsx — no logic changes):

```ts
// App.tsx:83-94
export function renderHighlightedText(text: string, query: string): React.ReactNode {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return text;
  const matcher = new RegExp(`(${escapeRegExp(normalizedQuery)})`, "gi");
  return text.split(matcher).map((part, index) => {
    if (part.toLowerCase() === normalizedQuery.toLowerCase()) {
      return <mark key={`m-${index}`}>{part}</mark>;
    }
    return <span key={`t-${index}`}>{part}</span>;
  });
}

// App.tsx:79-82
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// App.tsx:96-101
export function parseDurationHms(value: string | undefined): number {
  if (typeof value !== "string") return 0;
  const parts = value.split(":").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// App.tsx:103-106
export function extractStartTimeHm(startedAtIso: string): string {
  const match = startedAtIso.match(/T(\d{2}:\d{2})/);
  return match?.[1] ?? "";
}

// App.tsx:108-116
export function joinSessionAudioPath(sessionDir: string, audioFile: string): string {
  const normalizedDir = sessionDir.trim().replace(/[\\/]+$/, "");
  const normalizedFile = audioFile.trim().replace(/^[\\/]+/, "");
  if (!normalizedDir) return normalizedFile;
  if (normalizedDir.includes("\\")) {
    return `${normalizedDir}\\${normalizedFile.replace(/\//g, "\\")}`;
  }
  return `${normalizedDir}/${normalizedFile.replace(/\\/g, "/")}`;
}

// App.tsx:118-124
export function resolveSessionAudioPath(item: SessionListItem): string | null {
  const fallbackAudioFile =
    item.audio_format && item.audio_format !== "unknown" ? `audio.${item.audio_format}` : "";
  const audioFile = (item.audio_file ?? fallbackAudioFile).trim();
  if (!audioFile) return null;
  return joinSessionAudioPath(item.session_dir, audioFile);
}

// App.tsx:126-134
export function pauseAudioElement(audio: HTMLAudioElement | null, force = false): void {
  if (!audio) return;
  if (!force && audio.paused) return;
  try {
    audio.pause();
  } catch {
    // jsdom does not fully implement media playback APIs.
  }
}
```

Add `import React from "react"` and `import type { SessionListItem } from "../types"` at the top of appUtils.ts.

- [ ] **Step 2: Create `src/components/sessions/AudioPlayer.tsx`**

Move `SessionAudioPlayer` from App.tsx:145–257, rename to `AudioPlayer`, update imports:

```tsx
import { useEffect, useRef, useState } from "react";
import { Button, Slider } from "antd";
import type { SessionListItem } from "../../types";
import { parseDurationHms, pauseAudioElement, resolveSessionAudioPath } from "../../lib/appUtils";
import { tauriConvertFileSrc } from "../../lib/tauri";
import { getErrorMessage } from "../../lib/appUtils";

type AudioPlayerProps = {
  item: SessionListItem;
  setStatus: (status: string) => void;
};

export function AudioPlayer({ item, setStatus }: AudioPlayerProps) {
  // identical to SessionAudioPlayer body from App.tsx:145-257
  // only class name change: remove className from outer div — use inline style instead:
  // style={{ display: "flex", alignItems: "center", gap: 8, opacity: isDisabled ? 0.4 : 1 }}
}
```

The `className={`session-audio-player${isDisabled ? " is-disabled" : ""}`}` outer div becomes:
```tsx
<div style={{ display: "flex", alignItems: "center", gap: 8, opacity: isDisabled ? 0.4 : 1 }}>
```

The `className="session-audio-toggle"` Button becomes a plain Ant Design Button with `type="text"` and `size="small"`:
```tsx
<Button
  htmlType="button"
  type="text"
  size="small"
  aria-label={isPlaying ? "Пауза" : "Воспроизвести аудио"}
  onClick={() => void togglePlayback()}
  disabled={isDisabled}
  icon={/* SVG */}
/>
```

The Slider stays as-is (already Ant Design). Remove `className="session-audio-slider"`.

- [ ] **Step 3: Create `src/components/sessions/ArtifactModal.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { Button, Modal, Typography } from "antd";
import type { SessionArtifactPreview } from "../../types";
import { renderHighlightedText } from "../../lib/appUtils";

type ArtifactModalProps = {
  preview: SessionArtifactPreview | null;
  onClose: () => void;
};

export function ArtifactModal({ preview, onClose }: ArtifactModalProps) {
  const bodyRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!preview) return;
    const firstMatch = bodyRef.current?.querySelector("mark");
    if (!(firstMatch instanceof HTMLElement) || typeof firstMatch.scrollIntoView !== "function") return;
    firstMatch.scrollIntoView({ block: "center" });
  }, [preview]);

  return (
    <Modal
      open={Boolean(preview)}
      title="Просмотр артефакта"
      closable={false}
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>Закрыть</Button>,
      ]}
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
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 400, overflowY: "auto" }}
          >
            {renderHighlightedText(preview.text, preview.query)}
          </pre>
        </>
      )}
    </Modal>
  );
}
```

- [ ] **Step 4: Create `src/components/sessions/DeleteConfirmModal.tsx`**

```tsx
import { useRef } from "react";
import { Button, Modal } from "antd";
import type { DeleteTarget } from "../../types";

type DeleteConfirmModalProps = {
  deleteTarget: DeleteTarget | null;
  deletePendingSessionId: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteConfirmModal({
  deleteTarget, deletePendingSessionId, onCancel, onConfirm,
}: DeleteConfirmModalProps) {
  return (
    <Modal
      open={Boolean(deleteTarget)}
      title="Подтверждение удаления"
      closable={false}
      onCancel={onCancel}
      footer={[
        <Button
          key="cancel"
          autoFocus
          onClick={onCancel}
          disabled={deletePendingSessionId !== null}
        >
          Отмена
        </Button>,
        <Button
          key="delete"
          danger
          onClick={onConfirm}
          loading={deletePendingSessionId !== null}
        >
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
```

- [ ] **Step 5: Create `src/components/sessions/SummaryPromptModal.tsx`**

```tsx
import { Button, Input, Modal } from "antd";

type SummaryPromptDialogState = {
  sessionId: string;
  value: string;
  saving: boolean;
};

type SummaryPromptModalProps = {
  dialog: SummaryPromptDialogState | null;
  onCancel: () => void;
  onConfirm: () => void;
  onChange: (value: string) => void;
};

export function SummaryPromptModal({ dialog, onCancel, onConfirm, onChange }: SummaryPromptModalProps) {
  return (
    <Modal
      open={Boolean(dialog)}
      title="Промпт саммари"
      closable={false}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel} disabled={dialog?.saving}>Отмена</Button>,
        <Button key="ok" onClick={onConfirm} loading={dialog?.saving}>Ок</Button>,
      ]}
    >
      {dialog && (
        <Input.TextArea
          rows={8}
          value={dialog.value}
          onChange={(e) => onChange(e.target.value)}
          disabled={dialog.saving}
        />
      )}
    </Modal>
  );
}
```

Export `SummaryPromptDialogState` from this file since it's used in MainPage too:
```tsx
export type { SummaryPromptDialogState };
```

- [ ] **Step 6: Create `src/components/sessions/SessionFilters.tsx`**

Toolbar with search input + import audio + refresh buttons:

```tsx
import { Button, Flex, Input, Typography } from "antd";
import type { InputRef } from "antd";
import { forwardRef } from "react";

type SessionFiltersProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onImportAudio: () => void;
  onRefresh: () => void;
  refreshAnimating: boolean;
};

export const SessionFilters = forwardRef<InputRef, SessionFiltersProps>(
  ({ searchQuery, onSearchChange, onImportAudio, onRefresh, refreshAnimating }, ref) => {
    return (
      <Flex vertical gap={8}>
        <Flex justify="space-between" align="center">
          <Typography.Text>Search sessions</Typography.Text>
          <Flex gap={8} align="center">
            <Button size="small" onClick={onImportAudio}>Загрузить аудио</Button>
            <Button
              type="text"
              size="small"
              aria-label="Refresh sessions"
              title="Refresh sessions"
              onClick={onRefresh}
              icon={
                <svg
                  key={refreshAnimating ? "spin" : "idle"}
                  viewBox="0 0 24 24"
                  width={16}
                  height={16}
                  aria-hidden="true"
                  style={refreshAnimating ? { animation: "spin 0.6s linear" } : undefined}
                >
                  <path
                    d="M20 12a8 8 0 1 1-2.34-5.66"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <path
                    d="M20 4v5h-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              }
            />
          </Flex>
        </Flex>
        <Input.Search
          ref={ref}
          id="session-search-input"
          aria-label="Search sessions"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          allowClear
        />
      </Flex>
    );
  }
);
SessionFilters.displayName = "SessionFilters";
```

Add a tiny CSS keyframe for the spin animation. Since this is a one-liner animation (can't be done with Ant Design tokens), add it to a tiny CSS module:

Create `src/components/sessions/SessionFilters.module.css`:
```css
@keyframes spin { to { transform: rotate(360deg); } }
```

Import and use in `SessionFilters.tsx`:
```tsx
import styles from "./SessionFilters.module.css";
// use: style={refreshAnimating ? { animation: `${styles.spin} 0.6s linear` } : undefined}
```

Actually `@keyframes` can't be referenced directly via CSS modules. Use a global animation name instead:
```css
/* SessionFilters.module.css */
.spinIcon { animation: sessionRefreshSpin 0.6s linear; }
@keyframes sessionRefreshSpin { to { transform: rotate(360deg); } }
```

```tsx
// in JSX:
style={refreshAnimating ? undefined : undefined}
// apply className to the svg instead:
<svg className={refreshAnimating ? styles.spinIcon : undefined} ...>
```

- [ ] **Step 7: Create `src/components/sessions/SessionCard.tsx`**

The most complex component. Contains one session's card (App.tsx:1392–1626).

```tsx
import { Button, Card, Col, Flex, Input, Row, Select, Space, Tag, Typography } from "antd";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { PipelineUiState, SessionListItem, SessionMetaView } from "../../types";
import { fixedSources } from "../../types";
import { AudioPlayer } from "./AudioPlayer";
import { extractStartTimeHm } from "../../lib/appUtils";
import { formatSessionStatus } from "../../lib/status";

type SessionCardProps = {
  item: SessionListItem;
  detail: SessionMetaView;
  textPending: boolean;
  summaryPending: boolean;
  pipelineState: PipelineUiState | undefined;
  searchQuery: string;
  knownTagOptions: { value: string; label: string }[];
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, sessionId: string) => void;
  onDetailChange: (detail: SessionMetaView) => void;
  onOpenArtifact: (sessionId: string, kind: "transcript" | "summary") => void;
  onGetText: (sessionId: string) => void;
  onGetSummary: (sessionId: string) => void;
  onOpenSummaryPrompt: (detail: SessionMetaView) => void;
  onDelete: (sessionId: string, isRecording: boolean) => void;
  onOpenFolder: (sessionDir: string) => void;
  setStatus: (status: string) => void;
};

export function SessionCard({
  item, detail, textPending, summaryPending, pipelineState, searchQuery,
  knownTagOptions, onContextMenu, onDetailChange, onOpenArtifact,
  onGetText, onGetSummary, onOpenSummaryPrompt, onDelete, onOpenFolder, setStatus,
}: SessionCardProps) {
  const query = searchQuery.trim().toLowerCase();
  const sourceMatch = query !== "" && detail.source.toLowerCase().includes(query);
  const notesMatch = query !== "" && detail.notes.toLowerCase().includes(query);
  const topicMatch = query !== "" && detail.topic.toLowerCase().includes(query);
  const tagsText = detail.tags.join(", ");
  const tagsMatch = query !== "" && tagsText.toLowerCase().includes(query);
  const pathMatch = query !== "" && item.session_dir.toLowerCase().includes(query);
  const statusMatch = query !== "" && item.status.toLowerCase().includes(query);
  const startTimeHm = extractStartTimeHm(item.started_at_iso);
  const sessionTitleMeta = startTimeHm
    ? `(${item.audio_format}) - ${item.display_date_ru} ${startTimeHm}`
    : `(${item.audio_format}) - ${item.display_date_ru}`;
  const fixedSourceOptions = fixedSources.map((s) => ({ value: s, label: s }));

  // Suppress unused variable warning for pathMatch (used for future highlighting)
  void pathMatch;

  return (
    <Card
      size="small"
      style={{ marginBottom: 8 }}
      onContextMenu={(e) => onContextMenu(e as ReactMouseEvent<HTMLElement>, item.session_id)}
    >
      {/* Header: title + status + actions */}
      <Flex justify="space-between" align="flex-start" gap={8} style={{ marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Flex align="baseline" gap={8} wrap="wrap">
            <Typography.Text strong style={{ fontSize: 14 }}>
              {detail.topic || "Без темы"}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {sessionTitleMeta}
            </Typography.Text>
          </Flex>
          <Typography.Text
            type={statusMatch ? "warning" : "secondary"}
            style={{ fontSize: 12 }}
          >
            Status: {formatSessionStatus(item.status)}
          </Typography.Text>
        </div>

        <Flex gap={4} align="center" shrink={0}>
          {/* Artifact label buttons */}
          {item.has_transcript_text && (
            <Button
              size="small"
              type={transcriptMatch ? "primary" : "default"}
              onClick={() => onOpenArtifact(item.session_id, "transcript")}
            >
              текст
            </Button>
          )}
          {item.has_summary_text && (
            <Button
              size="small"
              type={summaryMatch ? "primary" : "default"}
              onClick={() => onOpenArtifact(item.session_id, "summary")}
            >
              саммари
            </Button>
          )}
          {/* Icon actions */}
          <Button
            type="text"
            size="small"
            aria-label="Удалить сессию"
            title="Удалить сессию"
            onClick={() => onDelete(item.session_id, item.status === "recording")}
            icon={
              <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
                <path d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 7h2v8h-2v-8zm4 0h2v8h-2v-8zM7 10h2v8H7v-8z" fill="currentColor" />
              </svg>
            }
          />
          <Button
            type="text"
            size="small"
            aria-label="Открыть папку сессии"
            title="Открыть папку сессии"
            onClick={() => onOpenFolder(item.session_dir)}
            icon={
              <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
                <path d="M14 5h5v5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M19 5 11 13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M18 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
          />
        </Flex>
      </Flex>

      {/* Editable fields grid */}
      <Row gutter={[8, 4]}>
        <Col span={12}>
          <div style={sourceMatch ? { background: "rgba(255,200,0,0.15)", borderRadius: 4, padding: "2px 4px" } : undefined}>
            <label style={{ display: "block", fontSize: 12, marginBottom: 2 }}>Source</label>
            <Select
              size="small"
              style={{ width: "100%" }}
              aria-label="Source"
              value={detail.source}
              options={fixedSourceOptions}
              onChange={(value) => onDetailChange({ ...detail, source: value })}
            />
          </div>
        </Col>
        <Col span={12}>
          <div style={topicMatch ? { background: "rgba(255,200,0,0.15)", borderRadius: 4, padding: "2px 4px" } : undefined}>
            <label style={{ display: "block", fontSize: 12, marginBottom: 2 }}>Topic</label>
            <Input
              size="small"
              aria-label="Topic"
              value={detail.topic}
              onChange={(e) => onDetailChange({ ...detail, topic: e.target.value })}
            />
          </div>
        </Col>
        <Col span={12}>
          <div style={tagsMatch ? { background: "rgba(255,200,0,0.15)", borderRadius: 4, padding: "2px 4px" } : undefined}>
            <label style={{ display: "block", fontSize: 12, marginBottom: 2 }}>Tags</label>
            <Select
              size="small"
              style={{ width: "100%" }}
              aria-label="Tags"
              mode="tags"
              value={detail.tags}
              options={knownTagOptions}
              tokenSeparators={[","]}
              onChange={(value) => onDetailChange({ ...detail, tags: value })}
            />
          </div>
        </Col>
        <Col span={12}>
          <div style={notesMatch ? { background: "rgba(255,200,0,0.15)", borderRadius: 4, padding: "2px 4px" } : undefined}>
            <label style={{ display: "block", fontSize: 12, marginBottom: 2 }}>Notes</label>
            <Input.TextArea
              size="small"
              aria-label="Notes"
              value={detail.notes}
              autoSize={{ minRows: 1, maxRows: 4 }}
              onChange={(e) => onDetailChange({ ...detail, notes: e.target.value })}
            />
          </div>
        </Col>
      </Row>

      {/* Footer: pipeline buttons + audio player */}
      <Flex justify="space-between" align="center" style={{ marginTop: 8 }} wrap="wrap" gap={8}>
        <Flex gap={8} align="center" wrap="wrap">
          <Button
            size="small"
            onClick={() => onGetText(item.session_id)}
            disabled={item.status === "recording" || textPending || summaryPending}
            loading={textPending}
          >
            {textPending ? "Getting text..." : "Get text"}
          </Button>
          <Button
            size="small"
            onClick={() => onGetSummary(item.session_id)}
            disabled={
              item.status === "recording" || !item.has_transcript_text || summaryPending || textPending
            }
            loading={summaryPending}
          >
            {summaryPending ? "Getting summary..." : "Get Summary"}
          </Button>
          <Button
            type="text"
            size="small"
            aria-label="Настроить промпт саммари"
            title="Настроить промпт саммари"
            onClick={() => onOpenSummaryPrompt(detail)}
            icon={
              <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
                <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H11l-4.25 3.5A.75.75 0 0 1 5.5 18v-3.3A2.49 2.49 0 0 1 5 13.5v-7Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
          />
          {pipelineState && (
            <Typography.Text
              type={pipelineState.kind === "error" ? "danger" : "success"}
              style={{ fontSize: 12 }}
            >
              {pipelineState.text}
            </Typography.Text>
          )}
        </Flex>
        <Flex align="center" gap={8}>
          <AudioPlayer item={item} setStatus={setStatus} />
          <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
            {item.audio_duration_hms}
          </Typography.Text>
        </Flex>
      </Flex>
    </Card>
  );
}
```

Note: `transcriptMatch` and `summaryMatch` are computed from `sessionArtifactSearchHits` in the parent. Add them to props:
```tsx
type SessionCardProps = {
  // ...existing props...
  transcriptMatch: boolean;
  summaryMatch: boolean;
};
```

- [ ] **Step 8: Create `src/components/sessions/SessionList.tsx`**

Renders the list, empty state, context menu, and modals. Manages the `SummaryPromptDialog` state locally since it's session-specific.

```tsx
import { useRef, useState } from "react";
import { Dropdown, Empty, Flex, Menu, Typography } from "antd";
import type { InputRef, MenuProps } from "antd";
import type { MouseEvent as ReactMouseEvent } from "react";
import type {
  DeleteTarget,
  PipelineUiState,
  PublicSettings,
  SessionArtifactPreview,
  SessionListItem,
  SessionMetaView,
} from "../../types";
import { tauriInvoke } from "../../lib/tauri";
import { getErrorMessage } from "../../lib/appUtils";
import { SessionCard } from "./SessionCard";
import { ArtifactModal } from "./ArtifactModal";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { SummaryPromptModal, type SummaryPromptDialogState } from "./SummaryPromptModal";

type SessionListProps = {
  sessions: SessionListItem[];
  filteredSessions: SessionListItem[];
  sessionDetails: Record<string, SessionMetaView>;
  setSessionDetails: React.Dispatch<React.SetStateAction<Record<string, SessionMetaView>>>;
  sessionSearchQuery: string;
  sessionArtifactSearchHits: Record<string, { transcript_match?: boolean; summary_match?: boolean }>;
  textPendingBySession: Record<string, boolean>;
  summaryPendingBySession: Record<string, boolean>;
  pipelineStateBySession: Record<string, PipelineUiState>;
  deleteTarget: DeleteTarget | null;
  deletePendingSessionId: string | null;
  artifactPreview: SessionArtifactPreview | null;
  knownTags: string[];
  settings: PublicSettings | null;
  setDeleteTarget: (target: DeleteTarget | null) => void;
  confirmDeleteSession: () => Promise<void>;
  closeArtifactPreview: () => void;
  openSessionFolder: (dir: string) => void;
  openSessionArtifact: (sessionId: string, kind: "transcript" | "summary") => void;
  getText: (sessionId: string) => void;
  getSummary: (sessionId: string) => void;
  saveSessionDetails: (sessionId: string, detail: SessionMetaView) => Promise<boolean>;
  requestDeleteSession: (sessionId: string, isRecording: boolean) => void;
  setStatus: (status: string) => void;
};

type SessionContextMenuState = {
  sessionId: string;
  x: number;
  y: number;
};

export function SessionList({
  sessions, filteredSessions, sessionDetails, setSessionDetails, sessionSearchQuery,
  sessionArtifactSearchHits, textPendingBySession, summaryPendingBySession,
  pipelineStateBySession, deleteTarget, deletePendingSessionId, artifactPreview,
  knownTags, settings, setDeleteTarget, confirmDeleteSession, closeArtifactPreview,
  openSessionFolder, openSessionArtifact, getText, getSummary,
  saveSessionDetails, requestDeleteSession, setStatus,
}: SessionListProps) {
  const [summaryPromptDialog, setSummaryPromptDialog] = useState<SummaryPromptDialogState | null>(null);
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenuState | null>(null);
  const sessionContextMenuRef = useRef<HTMLSpanElement | null>(null);

  const knownTagOptions = knownTags.map((tag) => ({ value: tag, label: tag }));

  const hasSessions = sessions.length > 0;
  const normalizedQuery = sessionSearchQuery.trim();
  const hasQuery = normalizedQuery.length > 0;
  const emptyStateTitle = hasSessions
    ? hasQuery ? `No results for "${normalizedQuery}"` : "No matching sessions"
    : "No sessions yet";
  const emptyStateCopy = hasSessions
    ? hasQuery
      ? "Try a different search or clear the query to see all sessions."
      : "No sessions matched the current filters."
    : "New recordings will appear here with search, transcript, summary, and audio actions.";

  function getSessionDetail(item: SessionListItem): SessionMetaView {
    return (
      sessionDetails[item.session_id] ?? {
        session_id: item.session_id,
        source: item.primary_tag,
        notes: "",
        custom_summary_prompt: "",
        topic: item.topic,
        tags: [],
      }
    );
  }

  function openContextMenu(event: ReactMouseEvent<HTMLElement>, sessionId: string) {
    event.preventDefault();
    const menuWidth = 248;
    const menuHeight = 300;
    const viewportWidth = window.innerWidth || event.clientX + menuWidth;
    const viewportHeight = window.innerHeight || event.clientY + menuHeight;
    setSessionContextMenu({
      sessionId,
      x: Math.max(8, Math.min(event.clientX, viewportWidth - menuWidth)),
      y: Math.max(8, Math.min(event.clientY, viewportHeight - menuHeight)),
    });
  }

  async function openSummaryPromptDialog(detail: SessionMetaView) {
    const persistedPrompt = detail.custom_summary_prompt?.trim() ?? "";
    if (persistedPrompt) {
      setSummaryPromptDialog({ sessionId: detail.session_id, value: detail.custom_summary_prompt ?? "", saving: false });
      return;
    }
    let defaultPrompt = settings?.summary_prompt ?? "";
    if (!settings) {
      try {
        const currentSettings = await tauriInvoke<PublicSettings>("get_settings");
        defaultPrompt = currentSettings.summary_prompt;
      } catch (err) {
        setStatus(`error: ${getErrorMessage(err)}`);
      }
    }
    setSummaryPromptDialog({ sessionId: detail.session_id, value: defaultPrompt, saving: false });
  }

  async function confirmSummaryPrompt() {
    if (!summaryPromptDialog) return;
    const current = sessionDetails[summaryPromptDialog.sessionId];
    if (!current) { setSummaryPromptDialog(null); return; }
    const nextDetail: SessionMetaView = { ...current, custom_summary_prompt: summaryPromptDialog.value };
    setSummaryPromptDialog((prev) => prev ? { ...prev, saving: true } : prev);
    const saved = await saveSessionDetails(summaryPromptDialog.sessionId, nextDetail);
    if (saved) {
      setSummaryPromptDialog(null);
    } else {
      setSummaryPromptDialog((prev) => prev ? { ...prev, saving: false } : prev);
    }
  }

  // Context menu items (same logic as App.tsx:584-667)
  const contextItem = sessionContextMenu
    ? filteredSessions.find((s) => s.session_id === sessionContextMenu.sessionId)
    : null;
  const contextDetail = contextItem ? getSessionDetail(contextItem) : null;
  const contextTextPending = contextItem ? Boolean(textPendingBySession[contextItem.session_id]) : false;
  const contextSummaryPending = contextItem ? Boolean(summaryPendingBySession[contextItem.session_id]) : false;

  const contextMenuItems: MenuProps["items"] = contextItem
    ? [
        { key: "folder", label: "Открыть папку сессии" },
        ...(contextItem.has_transcript_text ? [{ key: "open-text", label: "Открыть текст" }] : []),
        ...(contextItem.has_summary_text ? [{ key: "open-summary", label: "Открыть саммари" }] : []),
        {
          key: "text",
          label: "Сгенерировать текст",
          disabled: contextItem.status === "recording" || contextTextPending || contextSummaryPending,
        },
        {
          key: "summary",
          label: "Сгенерировать саммари",
          disabled: contextItem.status === "recording" || !contextItem.has_transcript_text || contextSummaryPending || contextTextPending,
        },
        { key: "prompt", label: "Настроить промпт саммари" },
        { key: "delete", label: "Удалить", danger: true },
      ]
    : [];

  function runContextMenuItem(key: string) {
    if (!contextItem) return;
    setSessionContextMenu(null);
    if (key === "folder") void openSessionFolder(contextItem.session_dir);
    else if (key === "open-text") void openSessionArtifact(contextItem.session_id, "transcript");
    else if (key === "open-summary") void openSessionArtifact(contextItem.session_id, "summary");
    else if (key === "text") void getText(contextItem.session_id);
    else if (key === "summary") void getSummary(contextItem.session_id);
    else if (key === "prompt" && contextDetail) void openSummaryPromptDialog(contextDetail);
    else if (key === "delete") requestDeleteSession(contextItem.session_id, contextItem.status === "recording");
  }

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      {filteredSessions.length === 0 ? (
        <Empty description={<><Typography.Text strong>{emptyStateTitle}</Typography.Text><br/><Typography.Text type="secondary">{emptyStateCopy}</Typography.Text></>} />
      ) : (
        filteredSessions.map((item) => {
          const detail = getSessionDetail(item);
          const artifactHit = sessionArtifactSearchHits[item.session_id];
          const query = sessionSearchQuery.trim().toLowerCase();
          return (
            <SessionCard
              key={item.session_id}
              item={item}
              detail={detail}
              textPending={Boolean(textPendingBySession[item.session_id])}
              summaryPending={Boolean(summaryPendingBySession[item.session_id])}
              pipelineState={pipelineStateBySession[item.session_id]}
              searchQuery={sessionSearchQuery}
              knownTagOptions={knownTagOptions}
              transcriptMatch={query !== "" && Boolean(artifactHit?.transcript_match)}
              summaryMatch={query !== "" && Boolean(artifactHit?.summary_match)}
              onContextMenu={openContextMenu}
              onDetailChange={(d) => setSessionDetails((prev) => ({ ...prev, [item.session_id]: d }))}
              onOpenArtifact={openSessionArtifact}
              onGetText={getText}
              onGetSummary={getSummary}
              onOpenSummaryPrompt={openSummaryPromptDialog}
              onDelete={requestDeleteSession}
              onOpenFolder={openSessionFolder}
              setStatus={setStatus}
            />
          );
        })
      )}

      {/* Context menu */}
      {sessionContextMenu && contextItem && (
        <Dropdown
          open
          menu={{ items: [] }}
          dropdownRender={() => (
            <Menu
              aria-label="Действия сессии"
              items={contextMenuItems}
              onClick={({ key }) => runContextMenuItem(String(key))}
            />
          )}
          trigger={["click"]}
          onOpenChange={(open) => { if (!open) setSessionContextMenu(null); }}
        >
          <span
            ref={sessionContextMenuRef}
            style={{
              position: "fixed",
              left: sessionContextMenu.x,
              top: sessionContextMenu.y,
              width: 1,
              height: 1,
            }}
          />
        </Dropdown>
      )}

      {/* Modals */}
      <DeleteConfirmModal
        deleteTarget={deleteTarget}
        deletePendingSessionId={deletePendingSessionId}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDeleteSession()}
      />
      <ArtifactModal preview={artifactPreview} onClose={closeArtifactPreview} />
      <SummaryPromptModal
        dialog={summaryPromptDialog}
        onCancel={() => setSummaryPromptDialog(null)}
        onConfirm={() => void confirmSummaryPrompt()}
        onChange={(value) => setSummaryPromptDialog((prev) => prev ? { ...prev, value } : prev)}
      />
    </div>
  );
}
```

- [ ] **Step 9: Create `src/pages/MainPage/index.tsx`**

Calls all hooks, renders the two-tab layout (Sessions + Settings):

```tsx
import { useEffect, useRef, useState } from "react";
import { Button, Flex, Tabs } from "antd";
import type { InputRef } from "antd";
import { useRecordingController } from "../../hooks/useRecordingController";
import { useSessions } from "../../hooks/useSessions";
import { useSettingsForm } from "../../hooks/useSettingsForm";
import { initializeAnalytics } from "../../lib/analytics";
import { getCurrentWindowLabel } from "../../lib/tauri";
import type { StartResponse } from "../../types";
import { SessionFilters } from "../../components/sessions/SessionFilters";
import { SessionList } from "../../components/sessions/SessionList";
import { SettingsPage } from "../SettingsPage";

type MainTab = "sessions" | "settings";

export function MainPage() {
  const [mainTab, setMainTab] = useState<MainTab>("sessions");
  const [topic, setTopic] = useState("");
  const [source, setSource] = useState("slack");
  const [session, setSession] = useState<StartResponse | null>(null);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [refreshAnimationCount, setRefreshAnimationCount] = useState(0);
  const sessionSearchInputRef = useRef<InputRef | null>(null);
  const loadSessionsRef = useRef<(() => Promise<void>) | null>(null);

  // No useSettingsForm here — SettingsPage (rendered in the settings tab) manages its own.
  // SessionList needs settings.summary_prompt as a fallback; it fetches directly via tauriInvoke
  // if settings is null, so we can safely pass null here.

  const {
    artifactPreview,
    closeArtifactPreview,
    confirmDeleteSession,
    deletePendingSessionId,
    deleteTarget,
    filteredSessions,
    getSummary,
    getText,
    importAudioSession,
    knownTags,
    loadSessions,
    openSessionFolder,
    openSessionArtifact,
    pipelineStateBySession,
    requestDeleteSession,
    saveSessionDetails,
    sessionArtifactSearchHits,
    sessionDetails,
    sessionSearchQuery,
    sessions,
    setDeleteTarget,
    setSessionDetails,
    setSessionSearchQuery,
    summaryPendingBySession,
    textPendingBySession,
  } = useSessions({ setStatus, lastSessionId, setLastSessionId });

  const { start, stop } = useRecordingController({
    enableTrayCommandListeners: true,
    isSettingsWindow: false,
    isTrayWindow: false,
    topic,
    setTopic,
    tagsInput: "",
    source,
    setSource,
    notesInput: "",
    session,
    setSession,
    lastSessionId,
    setLastSessionId,
    status,
    setStatus,
    loadSessions,
  });

  // Suppress unused variable warning (start/stop used via tray command listeners)
  void start;
  void stop;

  useEffect(() => {
    initializeAnalytics({ window_label: getCurrentWindowLabel() });
  }, []);

  useEffect(() => {
    loadSessionsRef.current = loadSessions;
  }, [loadSessions]);

  useEffect(() => {
    if (mainTab !== "sessions") return;
    loadSessionsRef.current?.().catch((err) => {
      setStatus(`error: ${String(err)}`);
    });
  }, [mainTab]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f") return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      const searchInput = sessionSearchInputRef.current?.input;
      searchInput?.focus();
      searchInput?.select();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function refreshSessions() {
    setRefreshAnimationCount((c) => c + 1);
    void loadSessions();
  }

  const tabItems = [
    {
      key: "sessions",
      label: "Sessions",
      children: (
        <Flex vertical style={{ height: "100%", gap: 8 }}>
          <SessionFilters
            ref={sessionSearchInputRef}
            searchQuery={sessionSearchQuery}
            onSearchChange={setSessionSearchQuery}
            onImportAudio={() => void importAudioSession()}
            onRefresh={refreshSessions}
            refreshAnimating={refreshAnimationCount > 0}
          />
          <SessionList
            sessions={sessions}
            filteredSessions={filteredSessions}
            sessionDetails={sessionDetails}
            setSessionDetails={setSessionDetails}
            sessionSearchQuery={sessionSearchQuery}
            sessionArtifactSearchHits={sessionArtifactSearchHits}
            textPendingBySession={textPendingBySession}
            summaryPendingBySession={summaryPendingBySession}
            pipelineStateBySession={pipelineStateBySession}
            deleteTarget={deleteTarget}
            deletePendingSessionId={deletePendingSessionId}
            artifactPreview={artifactPreview}
            knownTags={knownTags}
            settings={null}
            setDeleteTarget={setDeleteTarget}
            confirmDeleteSession={confirmDeleteSession}
            closeArtifactPreview={closeArtifactPreview}
            openSessionFolder={openSessionFolder}
            openSessionArtifact={openSessionArtifact}
            getText={getText}
            getSummary={getSummary}
            saveSessionDetails={saveSessionDetails}
            requestDeleteSession={requestDeleteSession}
            setStatus={setStatus}
          />
        </Flex>
      ),
    },
    {
      key: "settings",
      label: "Settings",
      children: <SettingsPage />,
    },
  ];

  return (
    <Flex
      vertical
      style={{ height: "100vh", padding: "12px 16px", boxSizing: "border-box" }}
    >
      <Tabs
        activeKey={mainTab}
        items={tabItems}
        onChange={(key) => setMainTab(key as MainTab)}
        style={{ flex: 1 }}
      />
    </Flex>
  );
}
```

Note: `SettingsPage` in the settings tab calls `useSettingsForm` internally. SessionList receives `settings={null}` — when the summary prompt dialog needs the default prompt, it falls back to `tauriInvoke("get_settings")` directly (see `openSummaryPromptDialog` in SessionList).

- [ ] **Step 10: Replace `src/App.tsx` with routing-only version**

```tsx
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { MainPage } from "./pages/MainPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TrayPage } from "./pages/TrayPage";

type WindowLabel = "main" | "settings" | "tray";

export function App() {
  const [label, setLabel] = useState<WindowLabel>("main");

  useEffect(() => {
    setLabel(getCurrentWindow().label as WindowLabel);
  }, []);

  if (label === "tray") return <TrayPage />;
  if (label === "settings") return <SettingsPage />;
  return <MainPage />;
}
```

- [ ] **Step 11: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 12: Commit**

```bash
git add src/components/sessions/ src/pages/MainPage/ src/pages/SettingsPage/ src/lib/appUtils.ts src/App.tsx
git commit -m "refactor: extract MainPage, SessionList, SessionCard and all session components"
```

---

### Task 6: Final cleanup

Delete all files that are no longer imported.

**Files:**
- Delete: `src/App.css`
- Delete: `src/appTypes.ts`
- Delete: `src/status.ts`
- Delete: `src/theme/useGlassTheme.ts`
- Delete: `src/theme/glassTheme.module.css`
- Delete: `src/features/` (entire directory)

- [ ] **Step 1: Verify nothing imports the old files**

```bash
grep -r "appTypes" src --include="*.ts" --include="*.tsx" | grep -v "src/types/"
grep -r "App.css" src --include="*.ts" --include="*.tsx"
grep -r "useGlassTheme" src --include="*.ts" --include="*.tsx"
grep -r "glassTheme" src --include="*.ts" --include="*.tsx"
grep -r "from.*status" src --include="*.ts" --include="*.tsx" | grep -v "src/lib/status"
grep -r "from.*features/" src --include="*.ts" --include="*.tsx"
```

Expected: no matches for any of these. If matches found, fix the imports before proceeding.

- [ ] **Step 2: Delete old files**

```bash
rm src/App.css
rm src/appTypes.ts
rm src/status.ts
rm src/theme/useGlassTheme.ts
rm src/theme/glassTheme.module.css
rm -rf src/features/
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Run build to verify no import errors**

```bash
npm run build
```

Expected: build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete legacy files — App.css, appTypes, features/, glass theme"
```

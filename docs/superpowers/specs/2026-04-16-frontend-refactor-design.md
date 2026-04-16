# Frontend Refactor Design

**Date:** 2026-04-16  
**Approach:** Page-by-page (TrayPage → SettingsPage → MainPage)

## Goals

1. Break monolithic `App.tsx` (1774 lines) into focused components
2. Establish modern directory structure (`pages/`, `components/`, `hooks/`, `types/`, `lib/`, `theme/`)
3. Replace glassmorphism CSS with standard Ant Design components and tokens
4. Preserve current grid and element layout exactly
5. Enable easy theme switching in the future via a single config file
6. Refactor tests alongside code

## Directory Structure

```
src/
├── main.tsx                        # Entry point (unchanged)
├── App.tsx                         # Routing only — no business logic
├── AppRoot.tsx                     # ConfigProvider + theme (unchanged)
│
├── types/
│   └── index.ts                    # ← appTypes.ts
│
├── pages/
│   ├── TrayPage/
│   │   └── index.tsx
│   ├── SettingsPage/
│   │   └── index.tsx
│   └── MainPage/
│       └── index.tsx
│
├── components/
│   ├── tray/
│   │   ├── RecordingControls.tsx
│   │   ├── AudioRow.tsx            # ← TrayAudioRow.tsx
│   │   └── AudioWave.tsx           # ← TrayAudioWave.tsx
│   ├── sessions/
│   │   ├── SessionList.tsx
│   │   ├── SessionCard.tsx
│   │   ├── SessionFilters.tsx
│   │   ├── AudioPlayer.tsx
│   │   ├── ArtifactModal.tsx
│   │   ├── DeleteConfirmModal.tsx
│   │   └── SummaryPromptModal.tsx
│   └── settings/
│       ├── GeneralSettings.tsx
│       ├── TranscriptionSettings.tsx
│       └── AudioSettings.tsx
│
├── hooks/
│   ├── useRecordingController.ts   # ← features/recording/
│   ├── useRecordingController.test.ts
│   ├── useSessions.ts              # ← features/sessions/
│   ├── useSessions.test.tsx
│   ├── useSettingsForm.ts          # ← features/settings/
│   └── useSettingsForm.test.tsx
│
├── lib/
│   ├── tauri.ts
│   ├── analytics.ts
│   ├── appUtils.ts
│   ├── validation.ts
│   └── status.ts                   # ← status.ts
│
└── theme/
    └── index.ts                    # Ant Design ThemeConfig — single source of truth
```

`src/features/` is removed entirely. `App.css` and `glassTheme.module.css` are deleted.

## App.tsx — Routing Only

```tsx
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'
import { MainPage } from './pages/MainPage'
import { SettingsPage } from './pages/SettingsPage'
import { TrayPage } from './pages/TrayPage'

type WindowLabel = 'main' | 'settings' | 'tray'

export default function App() {
  const [label, setLabel] = useState<WindowLabel>('main')

  useEffect(() => {
    setLabel(getCurrentWindow().label as WindowLabel)
  }, [])

  if (label === 'tray') return <TrayPage />
  if (label === 'settings') return <SettingsPage />
  return <MainPage />
}
```

## Styling Approach

### Rules
- No hardcoded colors or spacing values anywhere in component code
- All colors come from Ant Design tokens via `theme.useToken()` or component props
- Inline `style` props allowed only for structural sizing (window dimensions, fixed heights) where Ant Design has no equivalent prop
- No custom CSS files except where absolutely unavoidable for Tauri window chrome

### Theme Configuration

```ts
// theme/index.ts
import type { ThemeConfig } from 'antd'

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: '#0056c8',
    colorError: '#b53434',
    borderRadius: 8,
    borderRadiusLG: 12,
  },
  components: {
    // component-level overrides as needed
  }
}
```

To switch themes in the future: replace or swap `appTheme` in `AppRoot.tsx` — no other changes needed.

### CSS → Ant Design Mapping

| Current | Ant Design replacement |
|---------|----------------------|
| `.panel`, `.app-shell` | `Layout`, `Content` |
| Custom session cards | `Card` |
| Custom tabs | `Tabs` |
| Custom modals | `Modal` |
| Custom audio player | `Slider` + `Button` |
| Custom inputs/selects | `Input`, `Select`, `AutoComplete` |
| Custom buttons | `Button` (type, danger, size props) |
| Custom confirm dialog | `Modal.confirm` or `Popconfirm` |
| Settings form grid | `Form` + `Form.Item` |
| Custom Switch | `Switch` |
| Horizontal grids | `Row` / `Col` or `Flex` |

## Component Breakdown

### TrayPage (refactored first — smallest)

- `TrayPage/index.tsx` — flex column layout, status text at bottom
- `components/tray/RecordingControls.tsx` — Rec/Stop buttons + Source/Topic inputs
- `components/tray/AudioRow.tsx` — audio input row with mute toggle and level meter
- `components/tray/AudioWave.tsx` — Lottie waveform animation

### SettingsPage (refactored second)

- `SettingsPage/index.tsx` — `Tabs` with three tab panes
- `components/settings/GeneralSettings.tsx` — recording path, editor, sources
- `components/settings/TranscriptionSettings.tsx` — provider selection, API key
- `components/settings/AudioSettings.tsx` — device, format, bitrate

Note: `components/settings/` is shared — used both in `SettingsPage` (standalone settings window) and in `MainPage` (Settings tab inside the main window).

### MainPage (refactored last — largest)

- `MainPage/index.tsx` — `Tabs` with Sessions and Settings tab panes
- `components/sessions/SessionList.tsx` — `List` with scroll
- `components/sessions/SessionCard.tsx` — `Card` with metadata, action buttons, context menu
- `components/sessions/SessionFilters.tsx` — search + filters by source/tags/status
- `components/sessions/AudioPlayer.tsx` — `Slider` + play/pause `Button`
- `components/sessions/ArtifactModal.tsx` — `Modal` with artifact text
- `components/sessions/DeleteConfirmModal.tsx` — `Modal` for delete confirmation
- `components/sessions/SummaryPromptModal.tsx` — `Modal` for custom summary prompt

## Hooks

Hooks move from `features/` to `hooks/` with no logic changes. Tests move alongside their hooks.

- `useRecordingController` — recording start/stop, mute, live levels, tray sync
- `useSessions` — session list, filtering, artifact retrieval, deletion, metadata saving
- `useSettingsForm` — settings state, validation, API key storage, audio devices

## Types

`appTypes.ts` moves to `types/index.ts` without changes.

## Execution Order

1. Set up new directory structure, move `types/`, `lib/`, `hooks/` (no logic changes)
2. Create `theme/index.ts`, update `AppRoot.tsx`, delete CSS files
3. Refactor TrayPage: extract components, replace CSS with Ant Design
4. Refactor SettingsPage: extract components, replace CSS with Ant Design
5. Refactor MainPage: extract components, replace CSS with Ant Design
6. Slim down `App.tsx` to routing only
7. Delete `src/features/` directory

At each step: all tests pass before moving to the next step.

# Yandex.Disk sync — design

## Goal

Let the user mirror the local **recording root** to their Yandex.Disk account. Files are uploaded one-way (local → remote); nothing on Yandex.Disk is ever deleted by this feature, and files already present on Yandex.Disk with a matching name and byte-size are skipped. Sync can be triggered manually, runs at app startup when enabled, and then repeats on a user-chosen interval.

## User-facing behavior

- New settings tab **Sync Yandex.Disk** (fourth tab, after Generals / AudioToText / Audio).
- Fields on the tab:
  - Checkbox **Enable Yandex.Disk sync** (master switch for scheduled/startup runs).
  - **OAuth token** — password input + **Save token** button + status badge + **Clear** button + **Get token** button that opens `https://yandex.ru/dev/disk/poligon/` in the default browser.
  - **Folder on Yandex.Disk** — text input, default `BigEcho`.
  - **Sync interval** — select with four options: `1h`, `6h`, `24h`, `48h`. Default `24h`.
  - **Sync now** — primary button.
  - Live progress line while a run is active: `Processing N / M: <relative path>` + a thin progress bar.
  - **Last sync** panel with timestamp, duration, counters (`uploaded`, `skipped`, `failed`), and an expandable error list (first 20 entries) when `failed > 0`.
- Scheduled runs: when the checkbox is enabled and a token is saved, the app runs one sync at startup and then once per chosen interval while the app is running. A second run never overlaps the first.
- Manual runs (**Sync now**) work whenever a token is saved, regardless of the checkbox.
- Errors on individual files do not abort the run (skip & continue); they land in the last-run error list.

## Non-goals

- No two-way sync. Nothing is ever deleted or modified on Yandex.Disk by BigEcho.
- No download from Yandex.Disk back to local.
- No built-in OAuth authorization flow (no registered Yandex `client_id`, no loopback redirect, no refresh-token bookkeeping). Users paste a personal token they issued themselves on the Yandex.Disk Polygon page.
- No retries / exponential backoff on 429/5xx. A failed file is counted as `failed` and the run moves on.
- No cancellation of a running sync from the UI.
- No per-file type filters (the user asked for "everything in the root recordings folder").
- No persistence of `last_run` across app restarts. It lives in memory.
- No concurrent file uploads — serial upload only.

## Section 1 — Backend (Rust)

### 1.1 `PublicSettings` additions (`src-tauri/src/settings/public_settings.rs`)

```rust
pub struct PublicSettings {
    // …existing fields…
    pub yandex_sync_enabled: bool,          // default: false
    pub yandex_sync_interval: String,       // default: "24h"
    pub yandex_sync_remote_folder: String,  // default: "BigEcho"
}
```

The struct already carries `#[serde(default)]`, so old `settings.json` files without these fields deserialize cleanly with the defaults — no migration needed.

### 1.2 Validation in `PublicSettings::validate()`

- `yandex_sync_interval` must be one of `{"1h", "6h", "24h", "48h"}`, else `"Invalid Yandex sync interval"`.
- `yandex_sync_remote_folder`:
  - After `trim()` and stripping leading / trailing `/`, must be non-empty.
  - Must not contain `..`, `\`, or control characters.
  - Else `"Invalid Yandex remote folder"`.

### 1.3 Secret storage

Token is stored via the existing `settings::secret_store` under the key `YANDEX_DISK_OAUTH_TOKEN`. A new helper is added:

```rust
pub fn clear_secret(app_data_dir: &Path, name: &str) -> Result<(), String>
```

This removes the entry from the OS keyring (ignoring `NoEntry`) and from the fallback `secrets.local.json`. It is used by `yandex_sync_clear_token` and is deliberately generic so future secrets can reuse it.

### 1.4 New module tree `services/yandex_disk/`

```
src-tauri/src/services/yandex_disk/
    mod.rs
    client.rs        // HTTP client
    sync_runner.rs   // one sync pass
    scheduler.rs     // background timer
    state.rs         // runtime state types
```

`services::mod.rs` re-exports the new module alongside `pipeline_runner`.

#### `state.rs`

```rust
#[derive(Clone, Serialize)]
pub struct FileError { pub path: String, pub message: String }

#[derive(Clone, Serialize)]
pub struct LastRunSummary {
    pub started_at_iso: String,
    pub finished_at_iso: String,
    pub duration_ms: u64,
    pub uploaded: u32,
    pub skipped: u32,
    pub failed: u32,
    pub errors: Vec<FileError>,   // capped to first 20
}

#[derive(Default)]
pub struct YandexSyncRuntimeState {
    pub is_running: bool,
    pub last_run: Option<LastRunSummary>,
}

#[derive(Serialize)]
pub struct YandexSyncStatus {
    pub is_running: bool,
    pub last_run: Option<LastRunSummary>,
}
```

`YandexSyncRuntimeState` is held in `AppState` as `Arc<Mutex<YandexSyncRuntimeState>>`.

#### `client.rs`

Thin wrapper around `reqwest::Client`. Base URL: `https://cloud-api.yandex.net/v1/disk`. Auth header: `Authorization: OAuth <token>`.

Trait boundary (to make `sync_runner` unit-testable without HTTP):

```rust
#[async_trait::async_trait]
pub trait YandexDiskApi: Send + Sync {
    async fn ensure_dir(&self, remote_path: &str) -> Result<(), YandexError>;
    async fn list_dir(&self, remote_path: &str) -> Result<HashMap<String, u64>, YandexError>; // name -> size
    async fn upload_file(&self, remote_path: &str, local_path: &Path) -> Result<(), YandexError>;
}
```

`async_trait` is the one new dependency added for this (already idiomatic in the ecosystem). If we want to avoid it, we can return `Pin<Box<dyn Future>>` by hand — decide during implementation, not a design-breaking choice.

`ensure_dir` creates missing ancestors recursively via `PUT /resources?path=...`, treating `409 Conflict` as success. `list_dir` pages through `_embedded.items` with `limit=1000` (Yandex default cap); if the response has `_embedded.total > items.len()` the client loops with `offset`. Items with `type == "dir"` are excluded from the returned map (only file sizes matter for the sync decision).

`upload_file` does a two-step dance:
1. `GET /resources/upload?path=<...>&overwrite=false` → extracts `href` and optional `method` (spec says PUT).
2. `PUT <href>` with body = `reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(tokio::fs::File::open(...)))`. Sets `Content-Length` from file metadata so Yandex can accept the stream without buffering server-side. `201 Created` → ok; `409 Conflict` (collision we didn't anticipate) → also treated as ok with a debug log, since we already decided not to overwrite.

Errors are mapped into a single `YandexError` enum (network / http status / auth / parse) with short `Display` strings suitable for the UI. No stack traces leak the token.

#### `sync_runner.rs`

```rust
pub struct SyncParams {
    pub token: String,
    pub local_root: PathBuf,
    pub remote_folder: String,   // "BigEcho"
}

pub async fn run(
    params: SyncParams,
    api: Arc<dyn YandexDiskApi>,
    progress: impl Fn(SyncProgress) + Send + Sync,
) -> LastRunSummary
```

Algorithm:

1. `started_at = Utc::now()`.
2. Walk `local_root` with `walkdir` (or manual `std::fs::read_dir` recursion — whichever keeps build-deps small; `walkdir` is not yet in `Cargo.toml` so we prefer a small recursive helper).
3. Collect `Vec<LocalFile { rel_path, abs_path, size }>`. Empty list → return summary with zero counters.
4. Build `total = files.len()`. Emit `progress(Started { total })`.
5. `ensure_dir("disk:/<remote_folder>")`.
6. Group files by their parent relative directory; iterate directories in sorted order. For each directory:
   - `remote_dir = format!("disk:/{}/{}", remote_folder, rel_dir_posix)`. Path components are joined with `/` (POSIX), never backslashes, even on Windows.
   - `ensure_dir(remote_dir)`.
   - `remote_map = list_dir(remote_dir)`.
7. For each file in the directory (sorted by name for deterministic tests):
   - Emit `progress(Item { current: i+1, total, rel_path })`.
   - If `remote_map.get(name) == Some(&local_size)` → `skipped += 1`, continue.
   - Else: `upload_file(...)`. On `Ok` → `uploaded += 1`. On `Err(e)` → `failed += 1`; push `{ path: rel_path, message: e.to_string() }` into `errors` (capped at 20 entries to keep the summary bounded).
8. `finished_at = Utc::now()`. Emit `progress(Finished(summary.clone()))` and return the summary.

Progress event type:

```rust
pub enum SyncProgress {
    Started { total: u32 },
    Item { current: u32, total: u32, rel_path: String },
    Finished(LastRunSummary),
}
```

The `progress` callback is how the Tauri command layer forwards events. In tests it is a plain `Fn` that pushes into a `Vec`.

#### `scheduler.rs`

```rust
pub async fn run(app_handle: AppHandle, app_state: Arc<AppState>)
```

Loop:

1. Read settings + token. If `yandex_sync_enabled && token.is_some()` → call `trigger_sync(app_handle, app_state, "startup")`. Regardless of outcome, proceed.
2. `loop { sleep(current_interval); if enabled && token { trigger_sync(..., "scheduled"); } }`.

`current_interval` is re-read from settings right before each `sleep`. Mapping: `1h → 3600s, 6h → 6*3600s, 24h → 86400s, 48h → 172800s`.

`trigger_sync` takes the `Mutex<YandexSyncRuntimeState>`, returns early if `is_running` is already `true`, otherwise flips `is_running = true`, runs `sync_runner::run`, writes `last_run`, and sets `is_running = false`. It also forwards progress events as the Tauri event `yandex-sync-progress` (for `Item`) and `yandex-sync-finished` (for `Finished`).

For testability, `sleep` is injected as a parameter with default `tokio::time::sleep`; tests substitute a no-op that yields once and then exits the loop (via a `shutdown` signal channel also accepted as a parameter).

The scheduler is spawned once in `src-tauri/src/lib.rs` during `setup`:

```rust
tokio::spawn(services::yandex_disk::scheduler::run(app_handle, app_state));
```

### 1.5 Tauri commands (`commands/yandex_sync.rs`)

Registered in the `invoke_handler!` list in `src-tauri/src/lib.rs`.

| Command | Signature | Purpose |
|---|---|---|
| `yandex_sync_set_token` | `(token: String) -> Result<(), String>` | Validates non-empty, stores via `secret_store::set_secret` |
| `yandex_sync_clear_token` | `() -> Result<(), String>` | Calls `clear_secret` |
| `yandex_sync_has_token` | `() -> Result<bool, String>` | Reads via `get_secret`; `NoEntry` → `false` |
| `yandex_sync_now` | `() -> Result<LastRunSummary, String>` | Short-circuits with error `"Yandex sync already running"` if `is_running`. Otherwise reads settings + token and runs `sync_runner::run` on the current task, forwarding progress events to the frontend. Returns the final `LastRunSummary`. |
| `yandex_sync_status` | `() -> Result<YandexSyncStatus, String>` | Snapshot of runtime state |

(`open_external_url` already exists in `commands/updates.rs` and is used for the "Get token" button without modification.)

Secret strings never appear in any return value or error message exposed to the frontend.

## Section 2 — Frontend (React + TypeScript)

### 2.1 Type additions (`src/types/index.ts`)

```ts
export type PublicSettings = {
  // …existing…
  yandex_sync_enabled: boolean;
  yandex_sync_interval: "1h" | "6h" | "24h" | "48h";
  yandex_sync_remote_folder: string;
};

export type SettingsTab = "audiototext" | "generals" | "audio" | "yandex";

export type YandexSyncFileError = { path: string; message: string };
export type YandexSyncLastRun = {
  started_at_iso: string;
  finished_at_iso: string;
  duration_ms: number;
  uploaded: number;
  skipped: number;
  failed: number;
  errors: YandexSyncFileError[];
};
export type YandexSyncStatus = { is_running: boolean; last_run: YandexSyncLastRun | null };
export type YandexSyncProgress = { current: number; total: number; rel_path: string };
```

### 2.2 `src/components/settings/YandexSyncSettings.tsx`

Props:

```ts
type Props = {
  settings: PublicSettings;
  setSettings: (s: PublicSettings) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
};
```

Internal state (via a new hook `useYandexSync`):

- `hasToken: boolean`
- `tokenInput: string`
- `tokenSaveState: "unknown" | "updated" | "unchanged" | "error"` (reuse `SecretSaveState`)
- `status: YandexSyncStatus`
- `progress: YandexSyncProgress | null`

Layout (antd `Form`, `maxWidth: 760`):

1. Checkbox `Enable Yandex.Disk sync` — bound to `yandex_sync_enabled`.
2. `Form.Item` "OAuth token": `Input.Password` + `Save token` + status badge + `Clear`. Below: `Get token` button with `LinkOutlined`; clicking invokes the **already-existing** Tauri command `open_external_url(url: String)` (lives in `commands/updates.rs` and is already registered in `main.rs`). The frontend passes `"https://yandex.ru/dev/disk/poligon/"`. No new command needed.
3. `Form.Item` "Folder on Yandex.Disk": `Input`, default `BigEcho`. Disabled when `!enabled`.
4. `Form.Item` "Sync interval": `Select` with four options. Disabled when `!enabled`. Caption below: *Runs on app startup and every {interval} while the app is running.*
5. `Button` "Sync now" (primary). Disabled if `!hasToken || status.is_running`. Always clickable irrespective of `yandex_sync_enabled` (manual override).
6. Conditional progress block when `status.is_running && progress`: `Processing {current} / {total}: {rel_path}` and a `Progress` bar.
7. `last_run` card: rendered whenever `status.last_run` exists. Shows formatted date, duration (`Xm Ys`), counters, and an antd `Collapse` titled `Show errors` with the first 20 `FileError`s when `failed > 0`.

Dirty-dot in the tab label: driven by dirtiness of `yandex_sync_enabled`, `yandex_sync_interval`, `yandex_sync_remote_folder`. The token has its own save flow and does not raise the tab's dirty-dot (same pattern as Nexara / SalutSpeech / OpenAI keys).

### 2.3 Hook `src/hooks/useYandexSync.ts`

Responsibilities:

- `refreshHasToken()`, `saveToken(value)`, `clearToken()` — wrap `tauriInvoke`.
- `refreshStatus()` — invokes `yandex_sync_status`, stores into state. Called on mount, after `syncNow`, and on a light 2-second interval **only while the tab is mounted and `is_running` is true** (no polling otherwise).
- Subscribes to tauri events `yandex-sync-progress` (→ `progress`) and `yandex-sync-finished` (→ refresh status + clear `progress`) for the lifetime of the component.
- `syncNow()` — wraps `yandex_sync_now`; returns the final summary for the UI to display.

### 2.4 `SettingsPage` wiring (`src/pages/SettingsPage/index.tsx`)

- Extend `dirtyByTab` with `yandex:` entry.
- Add the fourth `tabItems` entry with key `"yandex"` and the new component.
- Nothing else changes; `useSettingsForm` already serializes/deserializes the whole `PublicSettings`.

### 2.5 App init (`src/App.tsx` / tray app) — no change required

Scheduling is entirely backend-side. The frontend only observes.

## Section 3 — Tests

### 3.1 Rust unit tests

**`settings/public_settings.rs`**
- `yandex_sync_defaults_are_disabled_with_24h_interval`
- `missing_yandex_sync_fields_use_defaults` (old `settings.json` without the three keys)
- `rejects_invalid_yandex_sync_interval`
- `rejects_remote_folder_with_invalid_chars`

**`services/yandex_disk/client.rs`** (new dev-dep: `wiremock`)
- `ensure_dir_treats_409_as_success`
- `ensure_dir_creates_missing_parents_recursively`
- `list_dir_parses_files_only_ignoring_directories`
- `list_dir_pages_through_large_directories`
- `upload_file_posts_correct_path_and_body`
- `upload_file_treats_409_as_success_with_log`
- `auth_header_is_oauth_prefixed`

**`services/yandex_disk/sync_runner.rs`** (with a `FakeApi` impl of the trait + `tempfile`)
- `empty_local_root_produces_zero_counters`
- `uploads_file_when_absent_on_remote`
- `skips_file_when_remote_size_matches`
- `uploads_file_when_remote_size_differs`
- `creates_missing_remote_directories_in_order`
- `continues_after_single_file_failure`
- `caps_error_list_at_twenty_entries`
- `emits_progress_events_in_order`

**`commands/yandex_sync.rs`** (with a test `AppState`)
- `set_token_then_has_token_returns_true`
- `clear_token_resets_has_token`
- `sync_now_rejects_when_already_running`

**`services/yandex_disk/scheduler.rs`** (with injected `sleep_fn` + shutdown channel)
- `triggers_on_startup_when_enabled_and_token_present`
- `does_not_trigger_when_disabled`
- `does_not_trigger_without_token`
- `skips_tick_when_already_running`

### 3.2 Frontend tests (`vitest` + RTL)

- `YandexSyncSettings.test.tsx`
  - Renders all fields; when `yandex_sync_enabled = false`, interval & remote-folder inputs are disabled.
  - `Save token` calls `yandex_sync_set_token` with the typed value and updates the badge.
  - `Clear` calls `yandex_sync_clear_token` and flips the badge back to "Not set".
  - `Sync now` is disabled when `hasToken = false` or `is_running = true`; enabled otherwise.
  - `last_run` rendering: counters and expanded errors.
  - `Get token` button triggers URL opening (shell mock).

- `useYandexSync.test.ts`
  - Subscribes to `yandex-sync-progress` / `yandex-sync-finished`.
  - Polls `yandex_sync_status` at 2s cadence only while `is_running`; stops when finished.

- Update `App.settings.test.tsx` to cover the fourth tab (rendering + switching).

### 3.3 Manual acceptance checklist (run by hand once backend + frontend land)

1. Issue a token on `yandex.ru/dev/disk/poligon/`, paste, `Save token` → badge shows "Saved".
2. With a non-empty `recording_root` and checkbox enabled, press `Sync now` → Yandex.Disk has a mirror tree under `BigEcho/`.
3. Press `Sync now` again → all files `skipped`, `uploaded = 0`.
4. Add a new file locally, press `Sync now` → only the new file is uploaded.
5. Turn off Wi-Fi, press `Sync now` → run finishes with `failed > 0`; the error list renders under `Show errors`.
6. `Clear token` → `Sync now` becomes disabled; backend scheduler tick produces no errors.
7. Set interval to `1h`, keep checkbox enabled, relaunch the app → startup sync triggers, scheduler keeps ticking.
8. Start a long sync, press `Sync now` again while it's running → UI shows the button as disabled and a new run does not begin.

## Section 4 — Dependencies

New crates in `src-tauri/Cargo.toml`:

- `async-trait = "0.1"` — for the `YandexDiskApi` trait. Optional; see §1.4.
- `tokio-util = { version = "0.7", features = ["io"] }` — `ReaderStream` for streaming uploads. Small, widely used.
- `[dev-dependencies] wiremock = "0.6"` — HTTP mock server for `client.rs` tests.

No new frontend packages.

## Section 5 — Rollout / migration

- No settings migration: `#[serde(default)]` handles pre-existing `settings.json`.
- No data migration on Yandex.Disk (first-ever run is the migration — creates `BigEcho/` and uploads everything).
- Feature defaults to disabled; the scheduler short-circuits when either the checkbox or the token is missing. A user who never touches the tab pays zero runtime cost beyond one no-op check at startup.

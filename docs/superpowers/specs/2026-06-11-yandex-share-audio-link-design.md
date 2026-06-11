# Кнопка «Поделиться» — публичная ссылка Яндекс.Диска на аудио сессии

**Дата:** 2026-06-11
**Статус:** утверждён

## Цель

В карточке сессии рядом с кнопкой «Открыть папку» появляется кнопка-иконка
«Поделиться» (`<ExportOutlined />`). По клику приложение публикует аудиофайл
сессии на Яндекс.Диске (если он там уже синхронизирован), получает публичную
ссылку «поделиться» (`public_url`) и открывает её в браузере по умолчанию.

Кнопка показывается **только** когда выполнены оба условия:

1. настроен OAuth-токен Яндекс.Диска;
2. аудиофайл этой сессии уже синхронизирован на Диск.

Для несинхронизированных сессий кнопки нет.

## Контекст

Интеграция с Яндекс.Диском уже есть — односторонний upload-синк:

- Трейт `YandexDiskApi` (`services/yandex_disk/client.rs`) с методами `ensure_dir`,
  `list_dir`, `upload_file` поверх REST `https://cloud-api.yandex.net/v1/disk`,
  авторизация заголовком `OAuth <token>`.
- `sync_runner::run` заливает файлы из `recording_root` в
  `disk:/{yandex_sync_remote_folder}/{rel_path}`, где `rel_path` — путь файла
  относительно `recording_root` (POSIX). Remote-путь строится в `remote_dir_for`.
- Токен лежит в secret store под ключом `TOKEN_KEY = "YANDEX_DISK_OAUTH_TOKEN"`
  (`services/yandex_disk/runner.rs`). Команды токена: `yandex_sync_has_token` и др.
  (`commands/yandex_sync.rs`).
- Настройки: `yandex_sync_remote_folder` (default `"BigEcho"`), `recording_root`
  (default `"./recordings"`) — `settings/public_settings.rs`.
- Синк эмитит событие `yandex-sync-finished` (`FINISHED_EVENT`) по завершении.

Per-session обработчики прокидываются `MainPage → SessionList → SessionCard`
как пропы (`onOpenFolder`, `onUploadToBrain` и т.д.). Backend уже умеет открывать
произвольные пути через ОС (`open` / `xdg-open` / `explorer`) в
`open_path_in_file_manager` (`commands/sessions.rs`) — `open <url>` на macOS
открывает браузер по умолчанию, аналогично для других ОС. Поэтому открытие ссылки
делаем **без** плагина-opener.

## Remote-путь аудио сессии

`session_dir` (абсолютный, хранится в БД) всегда лежит под `recording_root`
(см. `unique_session_dir`). Значит remote-путь аудио:

```
disk:/{remote_folder}/{rel}/{audio_file}
```

где `rel` = `session_dir` относительно `recording_root` в POSIX-форме, а
`audio_file` = `meta.artifacts.audio_file`. Это та же схема, что в `remote_dir_for`.

Чистая функция-расчёт выносится в новый модуль `services/yandex_disk/share.rs`:

```rust
pub fn remote_audio_path(
    remote_folder: &str,
    recording_root: &Path,
    session_dir: &Path,
    audio_file: &str,
) -> Option<String>
```

Возвращает `None`, если `audio_file` пуст или `session_dir` не лежит под
`recording_root` (нечего шарить). Юнит-тестируется независимо.

## Yandex API

Подтверждено по докам (`yandex.ru/dev/disk-api`):

1. **Публикация:** `PUT /v1/disk/resources/publish?path=<encoded>` →
   `200 OK`. Идемпотентно: повторная публикация возвращает тот же `public_url`.
2. **Чтение ссылки:** `GET /v1/disk/resources?path=<encoded>&fields=name,size,public_url`
   → `200` с JSON `{ "name": ..., "size": ..., "public_url": "https://disk.yandex.ru/d/..." }`.
   `404` — ресурса нет (не синхронизирован). `401/403` — проблема с токеном.

`public_url` — это и есть страница «поделиться» (просмотр + скачивание).

## Backend

### Расширение трейта `YandexDiskApi` (`client.rs`)

```rust
pub struct ResourceMeta { pub size: u64, pub public_url: Option<String> }

async fn resource_meta(&self, remote_path: &str) -> Result<Option<ResourceMeta>, YandexError>;
// GET /resources?path=...&fields=name,size,public_url
// 200 -> Some(meta); 404 -> None; 401/403 -> Unauthorized; прочее -> Http

async fn publish(&self, remote_path: &str) -> Result<(), YandexError>;
// PUT /resources/publish?path=...
// 200/201 -> Ok; 404 -> Http{404} (caller трактует как «не синхронизирован»);
// 401/403 -> Unauthorized
```

`FakeApi` в тестах `sync_runner` реализует трейт — добавляем туда дефолтные
реализации новых методов, чтобы не сломать существующие тесты.

### Команды (`commands/yandex_sync.rs`) + регистрация в `main.rs`

**`yandex_list_synced_sessions() -> Vec<String>`** — список `session_id`, чьё
аудио уже на Диске.

- Нет токена / пустой токен → `Ok(vec![])` (кнопка скрыта везде).
- Иначе: загрузить настройки, построить клиент, перечислить сессии
  (`repo_list_sessions`), для каждой с непустым `audio_file` посчитать
  `remote_audio_path` и **параллельно** (ограничение конкуренции, напр. 8 через
  `futures::stream::buffer_unordered` или семафор) вызвать `resource_meta`.
  `Some(_)` → `session_id` в результат; `None`/ошибка сети по конкретному
  файлу → пропускаем (не валим всю команду). `Unauthorized` → вернуть `Err`.
- `recording_root` берём через `resolved_local_root` / `root_recordings_dir`,
  `session_dir` — из `repo_list_sessions` (поле `session_dir`), `audio_file` —
  из `SessionListItem` (`audio_file`/fallback по `audio_format`) или из `meta`.

**`yandex_share_audio(session_id) -> String`** — публикация + ссылка + открыть.

1. Загрузить настройки и токен (нет токена → `Err`).
2. Найти `session_dir` (`get_session_dir`) и `audio_file` (`load_meta`).
   Посчитать `remote_audio_path` (None → `Err("Нет аудио для этой сессии")`).
3. `resource_meta(path)`: `None` → `Err("Файл ещё не синхронизирован на Диск")`.
4. `publish(path)`.
5. Повторно `resource_meta(path)` (или сразу из шага 3, если `public_url` уже
   присутствует) → взять `public_url`. Если `None` → `Err`.
6. Открыть `public_url` в браузере: новая внутренняя функция
   `open_url_in_browser(url)` рядом с `open_path_in_file_manager`-паттерном
   (вынести общий хелпер запуска ОС-команды, либо отдельная узкая функция).
7. Вернуть `public_url` (фронт покажет в статусе).

## Frontend

### `hooks/useSessions.ts`

- Новое состояние `syncedSessionIds: Set<string>` + загрузчик
  `refreshSyncedSessions()` — `invoke<string[]>("yandex_list_synced_sessions")`,
  кладёт результат в `Set`. Вызывается: при маунте (после загрузки списка) и по
  событию `yandex-sync-finished` (там же, где уже слушаются события синка). При
  ошибке — пустой `Set` (кнопки нет), без шумного статуса.
- `shareSessionAudio(sessionId)`:
  `invoke<string>("yandex_share_audio", { sessionId })`, при успехе
  `setStatus("Открыл ссылку в браузере: <url>")`, при ошибке
  `setStatus(getErrorMessage(e))`.
- Экспортировать `syncedSessionIds` и `shareSessionAudio` из хука.

### Проброс пропов `MainPage → SessionList → SessionCard`

- `onShare: (sessionId: string) => void` — `(id) => void shareSessionAudio(id)`.
- `canShare: boolean` для каждой карточки — `syncedSessionIds.has(item.session_id)`.

### `components/sessions/SessionCard.tsx`

- В `SessionCardProps`: `onShare`, `canShare`.
- В блоке `session-card-icon-actions` (рядом с «Открыть папку») — кнопка:

```tsx
{hasAudio && canShare && (
  <Button
    htmlType="button" type="text" size="small" shape="circle"
    className="session-share-button"
    aria-label="Поделиться ссылкой на аудио"
    title="Поделиться ссылкой на аудио (Яндекс.Диск)"
    icon={<ExportOutlined aria-hidden="true" style={{ color: "gray" }} />}
    onClick={() => onShare(item.session_id)}
  />
)}
```

`ExportOutlined` импортируется из `@ant-design/icons` (там же, где остальные).

## Тесты

**Rust:**
- `share::remote_audio_path`: корректный путь для вложенной сессии; `None` при
  пустом `audio_file`; `None` если `session_dir` вне `recording_root`; учёт
  `remote_folder` с обрамляющими слэшами.
- `client.rs` (wiremock): `resource_meta` → `Some` с `public_url` при 200,
  `None` при 404, `Unauthorized` при 401; `publish` → Ok при 200, маппинг 401.

**Frontend:**
- `SessionCard`: кнопка скрыта при `canShare=false`; видна и зовёт `onShare`
  при `hasAudio && canShare=true`.

## Затрагиваемые файлы

| Файл | Изменение |
|------|-----------|
| `src-tauri/src/services/yandex_disk/client.rs` | `ResourceMeta`, методы `resource_meta` + `publish` в трейт и `HttpYandexDiskClient`; wiremock-тесты |
| `src-tauri/src/services/yandex_disk/share.rs` | новый модуль: `remote_audio_path` + юнит-тесты |
| `src-tauri/src/services/yandex_disk/mod.rs` | `pub mod share;` |
| `src-tauri/src/services/yandex_disk/sync_runner.rs` | `FakeApi`: реализации новых методов трейта |
| `src-tauri/src/commands/yandex_sync.rs` | команды `yandex_list_synced_sessions`, `yandex_share_audio`; хелпер открытия URL |
| `src-tauri/src/main.rs` | импорт и регистрация двух новых команд в `invoke_handler` |
| `src/hooks/useSessions.ts` | `syncedSessionIds`, `refreshSyncedSessions`, `shareSessionAudio` |
| `src/components/sessions/SessionList.tsx` | проброс `onShare`, `canShare` |
| `src/pages/MainPage/index.tsx` | проброс `onShare`/`syncedSessionIds` из хука |
| `src/components/sessions/SessionCard.tsx` | кнопка `<ExportOutlined />` + пропы |
| `src/index.css` (если нужно) | стиль `.session-share-button` (по образцу соседних иконок) |

## Вне объёма (YAGNI)

- Не добавляем плагин-opener — открываем URL через существующий ОС-механизм.
- Не заливаем файл «на лету» при отсутствии на Диске — для несинхронизированных
  сессий кнопка просто скрыта.
- Не копируем ссылку в буфер и не показываем модалку — только открытие в браузере
  (+ статус с URL).
- Не храним признак «синхронизировано» в БД — определяем сетевым запросом и
  кэшируем во фронте.
- Не настраиваем параметры публикации (пароль, срок действия, доступы) — обычная
  публичная ссылка.
- Не делаем «отозвать публикацию» (unpublish).

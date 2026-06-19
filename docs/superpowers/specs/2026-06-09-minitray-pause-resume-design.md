# Пауза/возобновление записи в минитрее

**Дата:** 2026-06-09
**Статус:** утверждён

## Цель

Добавить в минитрей кнопку паузы. По нажатию запись приостанавливается; по
повторному — продолжается **с прошлого места** (бесшовно, без «дыры» в аудио).

## Суть: бесшовная пауза = пропуск записи сэмплов

Mic и system пишутся в отдельные RAW i16-файлы и в конце сводятся ffmpeg `amix`
(наложение по позиции сэмпла — дорожки выровнены от t=0). Поэтому во время паузы
**не пишем сэмплы** в файл на обеих дорожках синхронно (а не зануляем, как mute).
Оба файла перестают расти и продолжают с того же места → при сведении дорожки
остаются выровненными, в финале нет тишины-вставки.

Небольшая суб-буферная неточность на границах пауз неизбежна (стримы продолжают
доставлять буферы, мы их отбрасываем) — для рекордера встреч приемлемо.

Контраст с mute: `setMuted`/mic-mute пишут нули (файл растёт тишиной). Пауза
должна именно **пропускать** запись.

## Состояние (Rust)

В `SharedRecordingControl` (`audio/capture.rs`) добавить `paused: Arc<AtomicBool>`
рядом с mute-флагами + `set_paused(bool)`, `is_paused() -> bool`, `pause_flag()`,
и сброс в `reset()`. Флаг общий с потоками захвата через Arc — установка из
`AppState.recording_control` сразу видна mic-стримам.

## Захват

- **mic** (`append_mono_f32_as_i16` / `_i16` / `_u16_as_i16`): при `paused` —
  выставить метр уровня в 0 и `return` до записи в sink. Прокинуть `pause_flag`
  в `build_capture_stream` рядом с `mute_flag`.
- **macOS system** (`SystemAudioBridge/.../SystemAudioCapture.swift`): добавить
  `isPaused` + `@_cdecl bigecho_set_system_audio_capture_paused(handle, paused)`;
  в `didOutputSampleBuffer` при паузе — `return` (skip write, level 0). Rust:
  `NativeSystemAudioCapture::set_paused` + `extern "C"` объявление в
  `macos_system_audio.rs`.
- `ContinuousCapture::set_paused(paused)` — ставит общий флаг (mic via Arc) и
  зовёт нативный `set_paused` (system).

## Команда / состояние

`pub(crate) fn toggle_active_pause(state: &AppState) -> Result<bool, String>` в
`commands/recording.rs`: проверяет активную сессию, зовёт `capture.set_paused`,
возвращает новое состояние паузы. (Команда `#[tauri::command]` для фронта не
нужна — паузу инициирует только минитрей.)

## Минитрей (зеркало кнопки mic-mute)

- **Swift** (`Minitray.swift`): кнопка pause (SF Symbols `pause.fill` / `play.fill`)
  между mic и Stop, панель 230→260px; `@_silgen_name bigecho_minitray_rust_on_toggle_pause`;
  `@_cdecl bigecho_minitray_set_paused(_ paused: Bool)` → смена иконки.
- **`minitray.rs`**: `PAUSED_SINK` + `set_paused(paused)` (guard по `VISIBLE`);
  `extern "C" fn bigecho_minitray_set_paused`; `#[no_mangle] on_toggle_pause` →
  emit `minitray:toggle_pause_request`; production + test sink, reset.
- **`main.rs`**: listener `minitray:toggle_pause_request` → `toggle_active_pause`
  → `minitray::set_paused(...)` + broadcast `ui:pause {paused}`;
  helper `broadcast_pause(app, paused)`.
- Синк кнопки паузы в общей точке применения паузы и при показе панели
  (`show_if_enabled` call-sites в `recording.rs`/`settings.rs`), как у mic-mute.

## Фронт

- **`useRecordingController.ts`**: listener `ui:pause` → состояние `isPaused`
  (+ ref), экспорт `isPaused`. Сброс при старте/стопе записи.
- **`pages/TrayPage/index.tsx`**: таймер аккумулирует прошедшее время и не
  тикает во время паузы (через ref `isPaused`). Плоская волна — автоматически,
  т.к. уровни во время паузы = 0.

## Тесты

- Rust: `SharedRecordingControl` `set_paused`/`is_paused`/`reset`;
  `toggle_active_pause` инвертирует и возвращает состояние, ошибка без активной
  сессии; `minitray::set_paused` — no-op скрыто / зовёт sink видимо; mic
  `append_*` при `paused` не пишет в sink (метр в 0).
- FE: `ui:pause` замораживает таймер в трее (advance timers → пауза → таймер не
  растёт; resume → растёт).
- Swift — без юнит-тестов (как и Stop/mic-mute).

## Вне объёма (YAGNI)

- Управление паузой только из минитрея (не из трея-UI).
- Окно, открытое во время паузы, узнает о ней при следующем переключении — не
  трогаем `get_ui_sync_state`/`UiSyncStateView`.
- Без отдельной текстовой индикации «на паузе» в трее, кроме замороженного
  таймера и плоской волны.
- Mute и пауза независимы; их взаимодействие не специализируем.

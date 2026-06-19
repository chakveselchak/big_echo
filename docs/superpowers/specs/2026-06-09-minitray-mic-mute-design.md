# Кнопка мьюта микрофона в минитрее

**Дата:** 2026-06-09
**Статус:** утверждён

## Цель

Добавить в плавающий минитрей-оверлей (macOS NSPanel) кнопку мьюта/анмьюта
**микрофона** — такую же по поведению, как в трее-вебвью: во время записи
переключает микрофон, иконка отражает состояние (mic / mic.slash).

## Контекст

- Минитрей — нативная панель (`MinitrayBridge/.../Minitray.swift`), показывается
  во время записи, если включён `show_minitray_overlay`. Сейчас содержит:
  иконку приложения, волну уровня, кнопку Stop.
- Связь Swift↔Rust: Swift→Rust через `@_silgen_name`
  (`bigecho_minitray_rust_on_stop`, `…_on_icon`); Rust→Swift через `@_cdecl`
  (`bigecho_minitray_show/hide/update_level`), привязанные в `minitray.rs`
  через `extern "C"` + sink'и.
- Авторитет состояния мьюта — Rust: `AppState.recording_control`
  (`mic_muted: Arc<AtomicBool>`) + `active_capture` (реальный мьют потока).
  Команда `set_recording_input_muted{session_id, channel, muted}` пишет оба и
  возвращает `RecordingMuteState`. Фронт лишь зеркалит (начальное состояние из
  `get_ui_sync_state.mute_state`).
- Кнопка Stop в минитрее уже следует Rust-авторитетному паттерну: Swift→Rust
  `on_stop` → событие `minitray:stop_request` → `main.rs` останавливает запись и
  широковещательно шлёт `ui:recording` всем окнам.

## Поведение и поток

Зеркалим Rust-авторитетный паттерн Stop. Кнопка работает независимо от того,
подписан ли фронт.

**Клик в минитрее:**
```
Swift mic-button → bigecho_minitray_rust_on_toggle_mic()
  → emit "minitray:toggle_mic_request"
  → main.rs .listen(...) → toggle_active_mic_mute(state)  (новый helper)
      → minitray::set_mic_muted(snap.mic_muted)   // обновляет иконку кнопки
      → broadcast "ui:mute" {mute_state} всем окнам // трей-UI отражает
```

**Клик в трее-UI** (существующая команда `set_recording_input_muted`): в общем
пути применения мьюта при `channel == "mic"` дополнительно вызывается
`minitray::set_mic_muted(snapshot.mic_muted)`, чтобы кнопка минитрея всегда
показывала истину, кто бы ни переключил.

**Эхо-петли:** вещание `ui:mute` происходит только из пути, инициированного
минитреем. Собственные переключения трея уже применены оптимистично, поэтому
повторного эха им не шлём.

## Изменения по файлам

| Файл | Изменение |
|------|-----------|
| `…/MinitrayBridge/Sources/MinitrayBridge/Minitray.swift` | Кнопка mic (SF Symbols `mic.fill`/`mic.slash.fill`) слева от Stop; `@_silgen_name bigecho_minitray_rust_on_toggle_mic`; `@_cdecl bigecho_minitray_set_mic_muted(_ muted: Bool)` → меняет иконку |
| `src-tauri/src/services/minitray.rs` | `MIC_MUTED_SINK` + `pub fn set_mic_muted(muted)` (guard по `VISIBLE`, как `update_level`); `extern "C" fn bigecho_minitray_set_mic_muted`; `#[no_mangle] pub extern "C" fn bigecho_minitray_rust_on_toggle_mic` → emit `minitray:toggle_mic_request`; production + test sink, reset |
| `src-tauri/src/commands/recording.rs` | `pub(crate) fn toggle_active_mic_mute(state) -> Result<RecordingMuteState>`; в пути применения мьюта при `channel=="mic"` → `minitray::set_mic_muted` |
| `src-tauri/src/main.rs` | `.listen("minitray:toggle_mic_request")` → `toggle_active_mic_mute` + `broadcast_mic_mute`; helper `broadcast_mic_mute(app, mute_state)` (emit `ui:mute` всем окнам) |
| `src/hooks/useRecordingController.ts` | listener `ui:mute` → `applyMuteState(payload.mute_state)` |

## Тесты

- Rust `minitray.rs`: `set_mic_muted` — no-op когда панель скрыта; зовёт sink
  когда видима (по образцу `update_level`-тестов c test-sink).
- Rust `recording.rs`: `toggle_active_mic_mute` инвертирует `mic_muted` и
  возвращает корректный snapshot (есть test-stub capture + active_session).
- FE: listener `ui:mute` обновляет состояние мьюта (тест в `App.tray.test.tsx`
  или `App.main.test.tsx`).
- Swift юнит-тестами в репозитории не покрывается (как и текущий Stop/иконка).

## Вне объёма (YAGNI)

- Системный звук (`system`) не добавляем — только микрофон.
- Не меняем существующие Stop / иконку / волну уровня.
- Кнопка осмысленна только при активной записи (панель видна лишь тогда) —
  отдельной блокировки «нет записи» не добавляем.

# Автоматическая транскрибация по окончанию записи

**Дата:** 2026-06-09
**Статус:** утверждён

## Цель

Новая настройка в General Settings: «Автоматическая транскрибация по окончанию
записи». Когда включена — сразу после остановки записи автоматически запускается
**только транскрибация** (без саммари) выбранным провайдером транскрибации.

## Контекст

Уже существует настройка `auto_run_pipeline_on_stop` — запускает после остановки
полный pipeline (транскрибация **+** саммари), требует и `transcription_url`
(кроме salute_speech), и `summary_url`. Инфраструктура для «только транскрибации»
тоже есть: `PipelineMode::TranscriptionOnly` в `services/pipeline_runner.rs`.

Новая опция нужна тем, кому нужна только расшифровка без саммари.

## Поведение

Новый флаг `auto_transcribe_on_stop` (bool, default `false`).

В обработчике остановки записи (`src-tauri/src/main.rs`):

```rust
if should_auto_run_pipeline_after_stop(&settings) {        // Full: транскрибация + саммари
    run_pipeline_core(..., PipelineMode::Full, ...)
} else if should_auto_transcribe_after_stop(&settings) {   // TranscriptionOnly
    run_pipeline_core(..., PipelineMode::TranscriptionOnly, ...)
}
```

`should_auto_transcribe_after_stop(&settings)` = `auto_transcribe_on_stop &&
transcription_ready`, где `transcription_ready` использует ту же проверку, что и
существующая `should_auto_run_pipeline_after_stop` (salute_speech не требует URL;
остальные провайдеры требуют непустой `transcription_url`).

`else if` гарантирует приоритет полного pipeline и защищает от двойного запуска,
даже если оба флага окажутся `true` (например, в старом файле настроек).

## Взаимоисключение в UI

В `GeneralSettings.tsx` — два чекбокса рядом:

- «Auto-run pipeline on Stop»: при включении ставит `auto_run_pipeline_on_stop:
  true` **и** `auto_transcribe_on_stop: false`.
- «Автоматическая транскрибация по окончанию записи»: при включении ставит
  `auto_transcribe_on_stop: true` **и** `auto_run_pipeline_on_stop: false`.
- Снятие чекбокса просто выключает свой флаг.

Так одновременно может быть активна максимум одна из двух опций.

## Затрагиваемые файлы

| Файл | Изменение |
|------|-----------|
| `src-tauri/src/settings/public_settings.rs` | поле `auto_transcribe_on_stop` + default `false` |
| `src-tauri/src/main.rs` | `should_auto_transcribe_after_stop` + ветка `else if` в обработчике stop |
| `src/types/index.ts` | поле в `PublicSettings` |
| `src/components/settings/GeneralSettings.tsx` | новый чекбокс + взаимоисключающая логика на обоих чекбоксах |
| `src/pages/SettingsPage/index.tsx` | `isDirty("auto_transcribe_on_stop")` в группе `generals` |

## Тесты

- Rust: `should_auto_transcribe_after_stop` — true когда флаг включён и провайдер
  готов; false когда флаг выключен либо провайдер не готов (пустой URL у не-salute).
- Frontend (`App.settings.test.tsx`): включение одного чекбокса снимает другой.

## Вне объёма (YAGNI)

- Не меняем логику готовности apple_speech (зеркалим существующую проверку).
- Не добавляем авто-саммари / Brain-аплоад к новой ветке.
- Не трогаем механизм ретраев.

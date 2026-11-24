# Qwen model refresh

## What it does

DeepSeek Harness serves catalog providers (including the Qwen Token Plan routes)
from the pi-ai model catalog bundled with the application. Models released after
that bundle was built do not appear on their own — not at startup, not on a
timer. This plugin closes that gap:

1. Every hour (configurable) it calls the provider's own
   `GET {baseURL}/models` endpoint through the standard DSH model-discovery
   seam, authenticating with the route's credential.
2. It compares the disclosed ids with everything the route serves today.
3. New chat-model ids are **added** to the route's `models` list through the
   standard settings write path: full configuration validation, an atomic
   profile-patch write, and a live route rebuild without restarting the app.

## Guarantees

- **Additive only.** Existing entries keep every configured field (capacities,
  reasoning efforts, compat switches). Nothing is removed or retuned.
- **Union, never replacement.** When a route serves the bundled catalog, the
  written list starts from the full served catalog, so models the endpoint does
  not list are preserved.
- **Chat models only.** Image, audio, video, TTS/ASR models and the `auto`
  router alias are excluded by a configurable pattern.
- **No secrets in configuration.** The API key is resolved per cycle from the
  DSH credential store (`ctx.credentials`) and is never stored, logged, or
  written into any file by this plugin.

## Configuration

The plugin row (`qwen-model-refresh`) accepts:

| Field | Default | Meaning |
| --- | --- | --- |
| `providers` | `qwen-token-plan`, `qwen-token-plan-individual`, `qwen-token-plan-cn` | Route keys to refresh. A route is processed only when it is configured in the `llm-pi-ai` settings section; other routes are skipped with a log line. |
| `intervalMinutes` | `60` | Refresh period, minimum 1 minute. |
| `runOnStart` | `true` | Run one cycle ~5 s after the profile settles. |
| `excludePattern` | `(^auto$\|image\|audio\|video\|tts\|asr\|^wan)` | Case-insensitive regex of ids to ignore. |

## Limitations

- A newly added model gets the route's default capacities (context window
  1,000,000 / output 128,000 unless the endpoint discloses values) and no
  reasoning levels. Tune the entry in **Settings → Models** if needed; the
  plugin never touches it again.
- Routes must already be configured (present in the `llm-pi-ai` providers
  section) and their credential must resolve; the plugin does not create routes
  or store keys.
- One listing page is read; the Token Plan endpoints return the full list in one
  page.
- If the endpoint is unreachable or the key fails, the cycle logs a warning and
  retries on the next tick.

## Journal

Every activation, cycle result, skip reason, and error is appended to
`~/.dsh/logs/qwen-model-refresh.log` (one line per event, no secrets). The
Desktop host logger is not persisted, so this journal is the durable diagnostic
surface on any instance.

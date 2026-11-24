# dsh-qwen-model-refresh

Hourly model-list refresh for **Qwen Token Plan** routes in
[DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

DSH serves catalog providers from the pi-ai catalog bundled with the app, so
models released after your DSH build never appear on their own. This Host-only
bundle queries the provider's `GET {baseURL}/models` endpoint on a timer and
adds newly released **chat** models to your configured routes — additively,
through the standard settings write path, without restarting the app.

- Additive only: existing models and every tuned field are preserved.
- Union with the served catalog: models the endpoint does not list are kept.
- Non-chat ids (image/audio/video/TTS/ASR, `auto`) are excluded.
- The API key is resolved at runtime from the DSH credential store; the plugin
  contains no secrets and writes none into configuration.

## Install

```bash
git clone https://github.com/zznobzz/dsh-qwen-model-refresh.git
```

In DSH: **Plugins → Add plugin → local directory**, pick the cloned directory.
Or ask the agent to install it with `plugin_manager` `install_bundle`.

Requires a profile with the standard `llm-pi-ai`, `settings`, and `credentials`
services (the default Desktop/base composition) and at least one configured
Qwen Token Plan route whose credential resolves (e.g. `QWEN_TOKEN_PLAN_API_KEY`
in the credential store).

## Configure

The inserted row `qwen-model-refresh`:

```yaml
- id: qwen-model-refresh
  name: dsh-qwen-model-refresh
  config:
    providers:            # routes to refresh; unconfigured routes are skipped
      - qwen-token-plan
      - qwen-token-plan-individual
      - qwen-token-plan-cn
    intervalMinutes: 60   # minimum 1
    runOnStart: true
    # excludePattern: '(^auto$|image|audio|video|tts|asr|^wan)'
```

See [docs/DETAIL.md](docs/DETAIL.md) for behavior, guarantees, and limitations.

## How it works

Each cycle, per configured route:

1. Resolve the route's settings namespace and endpoint from the DSH
   configurable-provider directory (portable across profiles and instances).
2. Resolve the route's credential reference through `ctx.credentials`.
3. `ctx.llm.discoverModels(ns, { baseURL, api, apiKey })` — deliberately
   without a `provider` field, which forces a real network listing instead of
   the bundled-catalog answer.
4. Union the disclosed chat ids with everything the route serves today.
5. If there are additions, `ctx.settings.mutate(...)` writes the new `models`
   list with revision fencing; DSH validates, persists, and rebuilds the route
   live.

Failures are logged and retried on the next tick; a revision conflict retries
once immediately.

## License

MIT — see [LICENSE](LICENSE).

---

## Кратко по-русски

Плагин каждый час запрашивает `/models` у эндпоинта Qwen Token Plan и добавляет
новые chat-модели в настроенные маршруты `llm-pi-ai`. Только добавление:
существующие модели и их настройки не изменяются; список объединяется со
встроенным каталогом, ничего не теряется. Ключ читается из хранилища учётных
данных DSH во время работы и нигде не сохраняется. Настройка — в строке
`qwen-model-refresh` (маршруты, период, фильтр не-chat-моделей).

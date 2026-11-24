/**
 * qwen-model-refresh — periodic model-list refresh for Qwen Token Plan routes.
 *
 * DSH serves catalog providers from the pi-ai catalog bundled with the app, so
 * models released after that bundle was built never appear on their own. This
 * plugin interrogates the provider's own `GET {baseURL}/models` endpoint on a
 * timer and adds newly disclosed chat models to the configured routes through
 * the standard settings write path (validation, atomic profile-patch write,
 * live route rebuild — no restart).
 *
 * Guarantees:
 * - Additive only: existing entries keep every field the user configured;
 *   nothing is removed or retuned.
 * - Union, never replacement: when a route serves the bundled catalog (no
 *   explicit `models` list), the written list starts from the full served
 *   catalog, so models the endpoint does not list are preserved.
 * - Non-chat ids (image/audio/video/TTS/ASR, the `auto` router alias) are
 *   excluded by a configurable pattern.
 * - The API key is resolved per cycle through `ctx.credentials` and is never
 *   stored, logged, or written into configuration.
 *
 * @module dsh-qwen-model-refresh
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'qwen-model-refresh'
export const inject = ['llm']

/**
 * Append one event to the plugin's own log file. The host logger of a Desktop
 * profile is not persisted, so a background refresh plugin keeps its own
 * bounded journal: ~/.dsh/logs/qwen-model-refresh.log. Never carries secrets.
 * @param message - one-line event text.
 */
function journal(message) {
  try {
    const dir = join(homedir(), '.dsh', 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'qwen-model-refresh.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // A journal failure must never break a refresh cycle.
  }
}

/** Routes refreshed when the row config names none. */
const DEFAULT_ROUTES = ['qwen-token-plan', 'qwen-token-plan-individual', 'qwen-token-plan-cn']
/** Ids that are not chat models on the Token Plan endpoints. */
const DEFAULT_EXCLUDE = '(^auto$|image|audio|video|tts|asr|^wan)'
/** Credential-reference grammar of the harness credential seam. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Delay before the first cycle so the profile's entries settle. */
const STARTUP_DELAY_MS = 5_000

/** Human-readable error text without stack noise. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run a scheduling function outside any open HMR transaction.
 *
 * A plugin activated by a hot install runs inside the installer's HMR
 * transaction, and Node timers capture the async context of their creation
 * site: a timer created there would carry the transaction's AsyncLocalStorage
 * store into every tick, and the settings write path (which opens its own HMR
 * transaction) would refuse with "HMR transactions cannot be nested". Creating
 * the timer inside `executing.exit()` captures a clean context instead. The
 * HMR service's store is a runtime property; when it is absent (a composition
 * without HMR, or a future rename) scheduling falls through unchanged, which
 * is correct for boot-time activation.
 * @param ctx - plugin context.
 * @param schedule - creates and returns the timer handle.
 * @returns the timer handle.
 */
function scheduleOutsideTransaction(ctx, schedule) {
  const store = ctx.get('hmr')?.executing
  if (store instanceof AsyncLocalStorage && store.getStore()) {
    return store.exit(schedule)
  }
  return schedule()
}

/**
 * Refresh one provider route: discover, union, write.
 * @param ctx - plugin context with llm, settings, and credentials services.
 * @param route - provider route key (the llm-pi-ai providers dict key).
 * @param directory - configurable-provider directory snapshot for this cycle.
 * @param exclude - compiled id-exclusion pattern.
 * @param attempts - remaining attempts; a settings revision conflict retries once.
 */
async function refreshRoute(ctx, route, directory, exclude, attempts) {
  const entry = directory.find(candidate => candidate.provider === route)
  if (entry === undefined) {
    ctx.logger.info(`[qwen-model-refresh] ${route}: no adapter knows this route; skipping`)
    journal(`${route}: skip — no adapter directory entry`)
    return
  }
  const descriptor = ctx.settings.describe().find(candidate => candidate.ns === entry.settingsNs)
  if (descriptor === undefined) {
    ctx.logger.warn(`[qwen-model-refresh] ${route}: settings namespace "${entry.settingsNs}" is not configurable; skipping`)
    journal(`${route}: skip — namespace ${entry.settingsNs} not configurable`)
    return
  }
  const profile = descriptor.value?.providers?.[route]
  if (profile === undefined) {
    ctx.logger.info(`[qwen-model-refresh] ${route}: route is not configured in the profile; skipping`)
    journal(`${route}: skip — not configured in profile`)
    return
  }
  const baseURL = typeof profile.baseURL === 'string' && profile.baseURL.length > 0
    ? profile.baseURL
    : entry.defaultBaseURL
  if (typeof baseURL !== 'string' || baseURL.length === 0) {
    ctx.logger.warn(`[qwen-model-refresh] ${route}: no endpoint to interrogate; skipping`)
    journal(`${route}: skip — no endpoint`)
    return
  }
  const refName = typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0
    ? profile.apiKeyEnv
    : entry.nativeAuth?.env?.[0]
  let apiKey
  if (typeof refName === 'string' && REF_PATTERN.test(refName)) {
    apiKey = (await ctx.credentials.resolve(refName))?.value
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    ctx.logger.warn(`[qwen-model-refresh] ${route}: credential "${refName ?? '(none named)'}" does not resolve; skipping`)
    journal(`${route}: skip — credential ${refName ?? '(none named)'} does not resolve`)
    return
  }
  // No `provider` field: naming one would make discovery answer from the
  // bundled catalog without touching the network, which is exactly the
  // staleness this plugin exists to remove.
  const found = await ctx.llm.discoverModels(entry.settingsNs, {
    baseURL,
    api: typeof profile.api === 'string' && profile.api.length > 0 ? profile.api : 'openai-completions',
    apiKey,
  })
  const served = await ctx.llm.listModels(route)
  const configured = Array.isArray(profile.models)
    ? profile.models.filter(model => model && typeof model.id === 'string' && model.id.length > 0)
    : []
  // An explicit user list is preserved field by field; otherwise the written
  // list starts from everything the route serves today (the bundled catalog),
  // because a `models` list REPLACES the catalog at resolution time.
  const base = configured.length > 0 ? configured.map(model => ({ ...model })) : served.map(model => ({ id: model.id }))
  const known = new Set(base.map(model => model.id))
  const additions = []
  for (const model of found) {
    if (typeof model.id !== 'string' || model.id.length === 0) continue
    if (known.has(model.id) || exclude.test(model.id)) continue
    known.add(model.id)
    const row = { id: model.id }
    if (typeof model.name === 'string' && model.name.length > 0 && model.name !== model.id) row.name = model.name
    if (Number.isInteger(model.contextWindow) && model.contextWindow > 0) row.contextWindow = model.contextWindow
    if (Number.isInteger(model.maxTokens) && model.maxTokens > 0) row.maxTokens = model.maxTokens
    additions.push(row)
  }
  if (additions.length === 0) {
    ctx.logger.info(`[qwen-model-refresh] ${route}: up to date (${String(known.size)} models)`)
    journal(`${route}: up to date (${String(known.size)} models, endpoint listed ${String(found.length)})`)
    return
  }
  const next = [...base, ...additions]
  try {
    await ctx.settings.mutate(
      entry.settingsNs,
      [{ op: 'set', path: [...entry.settingsPath, 'models'], value: next }],
      descriptor.revision,
    )
  } catch (error) {
    if (error?.name === 'SettingsConflictError' && attempts > 1) {
      return refreshRoute(ctx, route, directory, exclude, attempts - 1)
    }
    throw error
  }
  ctx.logger.info(`[qwen-model-refresh] ${route}: added ${String(additions.length)} model(s): ${additions.map(model => model.id).join(', ')}`)
  journal(`${route}: added ${String(additions.length)}: ${additions.map(model => model.id).join(', ')}`)
}

/**
 * Mount the refresh timer once the settings and credentials services are live.
 * @param ctx - plugin context.
 * @param config - row configuration (providers, intervalMinutes, runOnStart, excludePattern).
 */
export function apply(ctx, config = {}) {
  journal(`apply: fiber active, config keys: ${Object.keys(config ?? {}).join(', ') || '(none)'}`)
  const routes = (Array.isArray(config.providers) ? config.providers : DEFAULT_ROUTES)
    .filter(route => typeof route === 'string' && route.length > 0)
  if (routes.length === 0) {
    ctx.logger.warn('[qwen-model-refresh] no provider routes configured; staying idle')
    return
  }
  const minutes = Number(config.intervalMinutes)
  const intervalMs = (Number.isFinite(minutes) && minutes >= 1 ? minutes : 60) * 60_000
  let exclude
  try {
    exclude = new RegExp(typeof config.excludePattern === 'string' ? config.excludePattern : DEFAULT_EXCLUDE, 'i')
  } catch {
    exclude = new RegExp(DEFAULT_EXCLUDE, 'i')
  }
  const runOnStart = config.runOnStart !== false

  ctx.inject(['settings', 'credentials'], (child) => {
    let busy = false
    const cycle = async () => {
      if (busy) return
      busy = true
      try {
        const directory = child.llm.listConfigurableProviders()
        for (const route of routes) {
          try {
            await refreshRoute(child, route, directory, exclude, 2)
          } catch (error) {
            child.logger.warn(`[qwen-model-refresh] ${route}: ${errorText(error)}`)
            journal(`${route}: ERROR ${errorText(error)}`)
          }
        }
      } catch (error) {
        child.logger.warn(`[qwen-model-refresh] cycle failed: ${errorText(error)}`)
        journal(`cycle ERROR ${errorText(error)}`)
      } finally {
        busy = false
      }
    }
    const timer = scheduleOutsideTransaction(child, () => setInterval(() => { void cycle() }, intervalMs))
    child.effect(() => () => clearInterval(timer))
    if (runOnStart) {
      const startup = scheduleOutsideTransaction(child, () => setTimeout(() => { void cycle() }, STARTUP_DELAY_MS))
      child.effect(() => () => clearTimeout(startup))
    }
    child.logger.info(`[qwen-model-refresh] active: routes ${routes.join(', ')}; every ${String(intervalMs / 60_000)} min`)
    journal(`active: routes ${routes.join(', ')}; every ${String(intervalMs / 60_000)} min; runOnStart=${String(runOnStart)}`)
  })
}
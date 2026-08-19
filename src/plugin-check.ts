/**
 * dsh-discovery deterministic plugin detection (background, progressive).
 *
 * A DSH plugin has a machine-checkable signature in package.json: a top-level
 * `dsh` field (bundle patch declaration) and/or a `@deepseek-ai/cordis`
 * peerDependency. GitHub's `dsh-plugin` topic is unreliable — any repo can tag
 * itself and big repos get swept in — so each repo is verified by pulling its
 * package.json from raw.githubusercontent.com (which does NOT consume the
 * api.github.com unauthenticated rate limit).
 *
 * Progressive by design: the listing returns instantly; this scanner runs in
 * the background with bounded concurrency and results are cached to disk, so
 * the next open reads the cache and needs no scan at all.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const RAW_BASE = 'https://raw.githubusercontent.com'
const FETCH_TIMEOUT_MS = 10000
const SCAN_CONCURRENCY = 8
/** 磁盘缓存有效期（24h）。 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** 网络失败后的重试冷却（10min）——unknown 不写盘，冷却期内不重复扫描。 */
const RETRY_COOLDOWN_MS = 10 * 60 * 1000

export type PluginKind = 'plugin' | 'not' | 'unknown'

export interface PluginScanState {
  /** 判定结果：key = `${owner}/${repo}` → 'plugin' | 'not'。网络失败记 'unknown'（不写盘）。 */
  statuses: Record<string, PluginKind>
  scanned: number
  total: number
  running: boolean
  /** 结果来自磁盘缓存（无本次扫描）。 */
  cached: boolean
}

/** package.json 文本 → 是否 DSH 插件（确定性签名：dsh 字段 / @deepseek-ai/cordis 依赖）。 */
export function isDshPlugin(pkgText: string): boolean {
  try {
    const pkg = JSON.parse(pkgText) as {
      dsh?: unknown
      peerDependencies?: Record<string, string>
      dependencies?: Record<string, string>
    }
    if (pkg.dsh !== undefined && pkg.dsh !== null) return true
    const peers = pkg.peerDependencies ?? {}
    if ('@deepseek-ai/cordis' in peers) return true
    const deps = pkg.dependencies ?? {}
    return '@deepseek-ai/cordis' in deps
  } catch {
    return false
  }
}

type RawResult =
  | { ok: true; text: string }
  | { ok: false; notFound: boolean }

/** raw 拉根目录 package.json（main/master 分支探测，纯 raw 不耗 API 配额）。 */
async function fetchRawPackageJson(owner: string, repo: string): Promise<RawResult> {
  let networkFailure = false
  for (const branch of ['main', 'master']) {
    try {
      const res = await fetch(`${RAW_BASE}/${owner}/${repo}/${branch}/package.json`, {
        headers: { 'user-agent': 'dsh-discovery' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.ok) return { ok: true, text: await res.text() }
      if (res.status === 404) continue
      return { ok: false, notFound: false }
    } catch {
      networkFailure = true
      // 超时/网络错误：尝试另一个分支
    }
  }
  if (networkFailure) return { ok: false, notFound: false }
  return { ok: false, notFound: true }
}

/** 当前激活 profile 名（与 host 侧一致：argv --profile）。 */
function resolveProfileName(): string {
  const idx = process.argv.indexOf('--profile')
  return idx >= 0 && process.argv[idx + 1] !== undefined ? process.argv[idx + 1] : 'web'
}

function cachePath(): string {
  return join(homedir(), '.dsh', 'profiles', resolveProfileName(), 'dsh-discovery-plugins.json')
}

interface CacheShape {
  savedAt: number
  statuses: Record<string, PluginKind>
}

function loadCache(): Record<string, PluginKind> {
  try {
    const raw = readFileSync(cachePath(), 'utf8')
    const parsed = JSON.parse(raw) as CacheShape
    if (typeof parsed.savedAt === 'number' && Date.now() - parsed.savedAt < CACHE_TTL_MS) {
      return parsed.statuses ?? {}
    }
    return {}
  } catch {
    return {}
  }
}

function writeCache(statuses: Record<string, PluginKind>): void {
  try {
    const payload: CacheShape = { savedAt: Date.now(), statuses }
    writeFileSync(cachePath(), JSON.stringify(payload), 'utf8')
  } catch {
    // 缓存写失败不影响主流程（下次重新扫描）
  }
}

/* ── 单例扫描状态（模块级，host 生命周期内共享） ──────────────────────────── */

const state: PluginScanState = { statuses: {}, scanned: 0, total: 0, running: false, cached: false }
let cacheLoaded = false
let scanPromise: Promise<void> | null = null
/** 网络失败冷却表：key → 失败时间戳（unknown 不写盘，冷却期内不重试）。 */
const failedAt = new Map<string, number>()

function ensureCacheLoaded(): void {
  if (cacheLoaded) return
  state.statuses = loadCache()
  state.cached = Object.keys(state.statuses).length > 0
  cacheLoaded = true
}

/** 同步读当前判定状态（供 system prompt 摘要等同步场景，确保磁盘缓存已加载）。 */
export function getPluginScanStateSync(): PluginScanState {
  ensureCacheLoaded()
  return state
}

/** 同步读已判定的插件判定统计（key 计数，供摘要）。 */
export function getPluginVerdictCounts(): { plugins: number; notPlugins: number; unknown: number } {
  let plugins = 0
  let notPlugins = 0
  let unknown = 0
  for (const kind of Object.values(state.statuses)) {
    if (kind === 'plugin') plugins += 1
    else if (kind === 'not') notPlugins += 1
    else unknown += 1
  }
  return { plugins, notPlugins, unknown }
}

/**
 * 启动/继续后台插件判定扫描。首次调用加载磁盘缓存；已有扫描在跑则复用。
 * 返回当前状态快照（调用方轮询即可）。
 */
export async function startPluginScan(entries: Array<{ owner: string; repo: string }>): Promise<PluginScanState> {
  ensureCacheLoaded()
  const now = Date.now()
  // 过滤出未判定且不在网络失败冷却期的
  const pendingKeys = entries
    .map((e) => `${e.owner}/${e.repo}`)
    .filter((k) => !(k in state.statuses) && (failedAt.get(k) ?? 0) + RETRY_COOLDOWN_MS <= now)
  if (pendingKeys.length === 0) {
    state.running = false
    state.scanned = 0
    state.total = 0
    return state
  }
  if (state.running && scanPromise !== null) {
    // 已有扫描在跑：不动 total（避免覆盖），返回当前状态
    return state
  }
  state.running = true
  state.cached = false
  state.scanned = 0
  state.total = pendingKeys.length
  const keys = [...pendingKeys]
  scanPromise = (async () => {
    let cursor = 0
    const workers = Array.from({ length: SCAN_CONCURRENCY }, async () => {
      while (cursor < keys.length) {
        const key = keys[cursor]!
        cursor += 1
        const parts = key.split('/')
        const result = await fetchRawPackageJson(parts[0]!, parts[1]!)
        if (result.ok) {
          state.statuses[key] = isDshPlugin(result.text) ? 'plugin' : 'not'
        } else if (result.notFound) {
          // 仓库不存在 / 无 package.json：确定性「非插件」
          state.statuses[key] = 'not'
        } else {
          // 网络失败：不写盘、不固化，进入冷却期
          failedAt.set(key, Date.now())
        }
        state.scanned += 1
      }
    })
    await Promise.all(workers)
    state.running = false
    state.scanned = 0
    state.total = 0
    writeCache(state.statuses)
    scanPromise = null
  })()
  return state
}

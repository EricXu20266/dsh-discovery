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

export type PluginKind = 'plugin' | 'not'

export interface PluginScanState {
  /** 判定结果：key = `${owner}/${repo}` → 'plugin' | 'not'。拉不到 package.json 记 'not'。 */
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

/** raw 拉根目录 package.json（main/master 分支探测，纯 raw 不耗 API 配额）。 */
async function fetchRawPackageJson(owner: string, repo: string): Promise<string | null> {
  for (const branch of ['main', 'master']) {
    try {
      const res = await fetch(`${RAW_BASE}/${owner}/${repo}/${branch}/package.json`, {
        headers: { 'user-agent': 'dsh-discovery' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.ok) return await res.text()
      if (res.status === 404) continue
      return null
    } catch {
      // 超时/网络错误：尝试另一个分支
    }
  }
  return null
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

/**
 * 启动/继续后台插件判定扫描。首次调用加载磁盘缓存；已有扫描在跑则复用。
 * 返回当前状态快照（调用方轮询即可）。
 */
export async function startPluginScan(entries: Array<{ owner: string; repo: string }>): Promise<PluginScanState> {
  if (!cacheLoaded) {
    state.statuses = loadCache()
    state.cached = Object.keys(state.statuses).length > 0
    cacheLoaded = true
  }
  // 过滤出未判定的
  const pendingKeys = entries
    .map((e) => `${e.owner}/${e.repo}`)
    .filter((k) => !(k in state.statuses))
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
        const text = await fetchRawPackageJson(parts[0]!, parts[1]!)
        state.statuses[key] = text !== null && isDshPlugin(text) ? 'plugin' : 'not'
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

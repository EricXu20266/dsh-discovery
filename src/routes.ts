/**
 * dsh-discovery host routes: read-only GitHub topic browsing.
 *
 * Security model: this plugin never installs, updates, uninstalls or
 * restarts anything. It only proxies the GitHub API's `dsh-plugin` topic
 * repository search (the official community channel DeepSeek documents) and
 * serves the listing to the browser UI. Opening a repository happens in the
 * browser (external link); installing is done by the user or the host agent
 * with `dsh plugin add <spec>` after reviewing the repo.
 *
 * Search fallback: GitHub's topic index lags for brand-new repositories (a
 * `dsh-plugin` topic can take hours to days to appear in topic search). The
 * `/dsh-discovery/search` route proxies GitHub's full-text repository search
 * (name/description/README) so fresh plugins are still discoverable by name.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sendJson } from './http.ts'
import { scanRepositoryCached } from './security.ts'
import { startPluginScan, type PluginScanState } from './plugin-check.ts'
import { readSettings, writeSettings } from './settings.ts'

export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface DiscoveryHost {
  webServer: WebServerService
  effect(callback: () => () => void, label: string): void
}

const GITHUB_API = 'https://api.github.com'
/** Cached listing; refresh happens on demand via ?force=1. */
let cache: { at: number; data: PluginListing | null } = { at: 0, data: null }
const TTL_MS = 5 * 60 * 1000

export interface PluginEntry {
  name: string
  owner: string
  description: string
  stars: number
  language: string | null
  updatedAt: string
  htmlUrl: string
  topics: string[]
  /** owner 类型：'org'=组织 / 'user'=个人（GitHub search API 直接返回，零额外请求）。 */
  ownerType: 'org' | 'user' | null
  /** 仓库创建时间（ISO，search API 自带）。 */
  repoCreatedAt: string
  /** fork 数（配合 stars 做刷星信号：star/fork 比异常 = 疑似刷星）。 */
  forks: number
  /** 确定性插件判定（后台渐进扫描填充）：'plugin' | 'not' | null(未判定)。 */
  isPlugin: 'plugin' | 'not' | null
}

export interface PluginListing {
  total: number
  plugins: PluginEntry[]
  fetchedAt: string
  /** GitHub search is paginated; 10 pages x 30 = 300 repos fetched. */
  source: 'github'
}

interface GitHubRepo {
  full_name: string
  description: string | null
  stargazers_count: number
  forks_count?: number
  language: string | null
  updated_at: string
  created_at?: string
  html_url: string
  topics?: string[]
  owner?: { type?: string }
}

/** search API 返回的仓库 → 插件条目（search API 自带 owner.type / created_at / forks，零额外请求）。 */
function toPluginEntry(repo: GitHubRepo): PluginEntry {
  const fullName = repo.full_name.split('/')
  return {
    name: fullName[1] ?? repo.full_name,
    owner: fullName[0] ?? '',
    description: repo.description ?? '',
    stars: repo.stargazers_count,
    language: repo.language,
    updatedAt: repo.updated_at,
    htmlUrl: repo.html_url,
    topics: repo.topics ?? [],
    ownerType: repo.owner?.type === 'Organization' ? 'org' : repo.owner?.type === 'User' ? 'user' : null,
    repoCreatedAt: repo.created_at ?? '',
    forks: repo.forks_count ?? 0,
    isPlugin: null,
  }
}

/** Fetch one page of GitHub search results for the dsh-plugin topic. */
async function fetchPage(page: number): Promise<GitHubRepo[]> {
  const url = `${GITHUB_API}/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=30&page=${page}`
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-discovery',
    },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`)
  const body = (await res.json()) as { items?: GitHubRepo[] }
  return body.items ?? []
}

/**
 * Pull up to 10 pages (~300 repos) concurrently. GitHub search API unauthenticated
 * quota is 10 req/min — 10 pages in parallel sits exactly at that limit, and any
 * failed page degrades to the pages that succeeded (serial version stopped at the
 * first failure, losing the tail).
 */
export async function fetchListing(): Promise<PluginListing> {
  if (cache.data !== null && Date.now() - cache.at < TTL_MS) return cache.data
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => fetchPage(i + 1)),
  )
  const all: GitHubRepo[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') all.push(...result.value)
  }
  const plugins: PluginEntry[] = all.map(toPluginEntry)
  const listing: PluginListing = {
    total: plugins.length,
    plugins,
    fetchedAt: new Date().toISOString(),
    source: 'github',
  }
  cache = { at: Date.now(), data: listing }
  return listing
}

/** Drop the cache (not used by the UI yet, but harmless to expose). */
export function invalidateListing(): void {
  cache = { at: 0, data: null }
}

/** 同步读当前 listing 缓存（供 system prompt 摘要等同步场景；无缓存返回 null）。 */
export function getCachedListing(): PluginListing | null {
  return cache.data
}

/* ── GitHub full-text search fallback ─────────────────────────────────────── */

/** 全文搜索缓存：关键词 → 结果（null = 查询失败）。TTL 防未认证 API 限流（60 req/h）。 */
const searchCache = new Map<string, { at: number; data: PluginEntry[] | null }>()
const SEARCH_TTL_MS = 5 * 60 * 1000

/**
 * GitHub 全文搜索兜底：topic 列表索引对新仓库有延迟（topic 已打但未收录），
 * 本地过滤无结果时走 search API 全文匹配 name/description/readme。
 * 不限定 topic，才能命中最新仓库。失败返回 null（区别于"无结果"的 []）。
 */
async function fetchSearch(q: string): Promise<PluginEntry[] | null> {
  const key = q.trim().toLowerCase()
  if (key === '') return []
  const cached = searchCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < SEARCH_TTL_MS) return cached.data
  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(key)}&per_page=30&sort=stars&order=desc`
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-discovery',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`)
    const body = (await res.json()) as { items?: GitHubRepo[] }
    const plugins: PluginEntry[] = (body.items ?? []).map(toPluginEntry)
    searchCache.set(key, { at: Date.now(), data: plugins })
    return plugins
  } catch {
    searchCache.set(key, { at: Date.now(), data: null })
    return null
  }
}

/* ── installed versions (multi-source comparison for one-click update) ─────── */

export interface InstalledVersion {
  name: string
  current: string
  /** npm registry 最新版（插件已发布 npm 时可查，否则 null）。 */
  latest: string | null
  /** npm 最新版发布时间（ISO，可查时）。 */
  latestPublishedAt: string | null
  /** GitHub 仓库 "owner/repo"（从插件 package.json repository 解析）。 */
  repo: string | null
  /** GitHub 远端最新 commit SHA。 */
  remoteSha: string | null
  /** GitHub 远端最新 commit 时间（ISO）。 */
  remotePushedAt: string | null
  /** 基线：上次建立/推进时记录的远端 SHA（null = 首次检查尚未建立基线）。 */
  baselineSha: string | null
  /** 是否检测到更新：npm latest ≠ current，或 GitHub 远端 SHA ≠ 基线 SHA（且插件本体未重装）。 */
  hasUpdate: boolean
  /** 检测到更新的来源：'npm' | 'github' | 'none'。 */
  source: 'npm' | 'github' | 'none'
}

/** 当前激活 profile 名（与 host 侧一致：argv --profile）。 */
function resolveProfileName(): string {
  const idx = process.argv.indexOf('--profile')
  return idx >= 0 && process.argv[idx + 1] !== undefined ? process.argv[idx + 1] : 'web'
}

/** profile 下某插件的 node_modules 路径（file:/github: 安装的插件在此为实体副本）。 */
function profileNodeModules(pkg: string): string {
  return join(homedir(), '.dsh', 'profiles', resolveProfileName(), 'node_modules', pkg)
}

/** 读已安装插件包自身 package.json；读不到返回 null。 */
function readInstalledPackage(pkg: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(profileNodeModules(pkg), 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 已安装插件 package.json 的 mtime（检测重装：file: 源更新后重装会复制新文件）。 */
function readInstalledMtime(pkg: string): number | null {
  try {
    return statSync(join(profileNodeModules(pkg), 'package.json')).mtimeMs
  } catch {
    return null
  }
}

/** 读已安装插件包自身 package.json 的 version（file:/github: 链接没有版本号，以包内为准）。 */
function readInstalledVersion(pkg: string): string | null {
  const doc = readInstalledPackage(pkg)
  return typeof doc?.version === 'string' ? doc.version : null
}

/** 从 package.json repository 字段解析 GitHub 仓库（支持 string / {url} / git+https / ssh 格式）。 */
function resolveRepo(pkg: string): { owner: string; repo: string } | null {
  const doc = readInstalledPackage(pkg)
  const repository = doc?.repository
  const url = typeof repository === 'string'
    ? repository
    : (repository as { url?: string } | undefined)?.url
  if (typeof url !== 'string') return null
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
  return m !== null ? { owner: m[1], repo: m[2] } : null
}

/** 查 npm registry 最新版 + 发布时间；非 npm 源（github: 等）或查询失败返回 null（诚实标注「无法检测」）。 */
async function fetchNpmInfo(pkg: string): Promise<{ latest: string | null; publishedAt: string | null }> {
  const encoded = pkg.startsWith('@') ? pkg.replace('/', '%2F') : pkg
  try {
    const res = await fetch(`https://registry.npmjs.org/${encoded}?fields=dist-tags,time`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return { latest: null, publishedAt: null }
    const body = (await res.json()) as { 'dist-tags'?: { latest?: string }; time?: Record<string, string> }
    const latest = body['dist-tags']?.latest ?? null
    const publishedAt = latest !== null ? (body.time?.[latest] ?? null) : null
    return { latest, publishedAt }
  } catch {
    return { latest: null, publishedAt: null }
  }
}

/** GitHub 远端最新 commit（TTL 缓存防未认证限流 60 req/h）。 */
interface GitHubHead {
  sha: string
  date: string
}
const ghHeadCache = new Map<string, { at: number; data: GitHubHead | null }>()
const GH_TTL_MS = 5 * 60 * 1000

async function fetchGitHubHead(owner: string, repo: string): Promise<GitHubHead | null> {
  const key = `${owner}/${repo}`
  const cached = ghHeadCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < GH_TTL_MS) return cached.data
  try {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/commits?per_page=1`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-discovery',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as Array<{ sha: string; commit?: { committer?: { date?: string } } }>
    const item = body[0]
    const result = item !== undefined
      ? { sha: item.sha, date: item.commit?.committer?.date ?? '' }
      : null
    ghHeadCache.set(key, { at: Date.now(), data: result })
    return result
  } catch {
    ghHeadCache.set(key, { at: Date.now(), data: null })
    return null
  }
}

/* ── 基线状态：记录「上次建立/推进时的远端 SHA」，SHA 变化即提示更新 ──────── */

interface BaselineRecord {
  sha: string
  checkedAt: string
  currentVersion: string | null
  fileMtime: number | null
}

interface BaselineState {
  plugins: Record<string, BaselineRecord>
}

function baselinePath(): string {
  return join(homedir(), '.dsh', 'profiles', resolveProfileName(), 'dsh-discovery-state.json')
}

function readBaseline(): BaselineState {
  try {
    return JSON.parse(readFileSync(baselinePath(), 'utf8')) as BaselineState
  } catch {
    return { plugins: {} }
  }
}

function writeBaseline(state: BaselineState): void {
  try {
    writeFileSync(baselinePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // 状态文件写失败不影响主流程（只影响下次比对）
  }
}

/**
 * 多源版本比对：npm registry（latest + 发布时间）+ GitHub 远端 commit（SHA 基线）。
 * 确定性操作（版本读取/比对）在代码完成，LLM 只负责对「需更新清单」做安全审查与安装执行。
 *
 * 基线语义：
 * - 首次检查：记录远端 SHA 为基线（不误报），UI 显示「基线已建立」。
 * - 插件本体变化（版本号或 package.json mtime 变化 = 重装/更新过）：基线推进到当前远端 SHA。
 * - 其余情况：远端 SHA ≠ 基线 SHA → 提示更新，基线不动（直到真正更新插件）。
 */
export async function installedVersions(listInstalled: () => string[]): Promise<InstalledVersion[]> {
  const names = listInstalled()
  const state = readBaseline()
  const settled = await Promise.allSettled(names.map(async (name): Promise<InstalledVersion> => {
    const current = readInstalledVersion(name)
    const npm = await fetchNpmInfo(name)
    const repo = resolveRepo(name)
    const gh = repo !== null ? await fetchGitHubHead(repo.owner, repo.repo) : null
    const record = state.plugins[name]
    const baselineSha = record?.sha ?? null
    const pkgMtime = readInstalledMtime(name)

    // 插件本体是否变化（重装/更新过）：版本号或 package.json mtime 任一变化
    const reinstalled = record !== undefined
      && (record.currentVersion !== current || record.fileMtime !== pkgMtime)

    let hasUpdate = false
    let source: InstalledVersion['source'] = 'none'
    if (npm.latest !== null && current !== null && npm.latest !== current) {
      hasUpdate = true
      source = 'npm'
    }
    if (gh !== null && baselineSha !== null && !reinstalled && gh.sha !== baselineSha) {
      hasUpdate = true
      source = 'github'
    }

    // 推进/建立基线：插件重装过，或首次检查
    if (gh !== null && (record === undefined || reinstalled)) {
      state.plugins[name] = {
        sha: gh.sha,
        checkedAt: new Date().toISOString(),
        currentVersion: current,
        fileMtime: pkgMtime,
      }
    }

    return {
      name,
      current: current ?? 'unknown',
      latest: npm.latest,
      latestPublishedAt: npm.publishedAt,
      repo: repo !== null ? `${repo.owner}/${repo.repo}` : null,
      remoteSha: gh?.sha ?? null,
      remotePushedAt: gh?.date ?? null,
      baselineSha,
      hasUpdate,
      source,
    } satisfies InstalledVersion
  }))
  writeBaseline(state)
  return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
}

/** Cached README text; refresh happens on demand (TTL-bounded). */
const README_TTL_MS = 5 * 60 * 1000
const readmeCache = new Map<string, { at: number; data: { markdown: string } | { error: string } }>()

/**
 * Fetch one repository README as raw Markdown. Read-only; serves the
 * discovery browser's in-panel repository preview (GitHub pages refuse
 * iframe embedding, so the UI renders the README instead).
 */
async function fetchReadme(owner: string, repo: string): Promise<string> {
  const key = `${owner}/${repo}`
  const cached = readmeCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < README_TTL_MS) {
    if ('markdown' in cached.data) return cached.data.markdown
    throw new Error(cached.data.error)
  }
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github.raw+json',
      'user-agent': 'dsh-discovery',
    },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    const error = `README HTTP ${res.status}`
    readmeCache.set(key, { at: Date.now(), data: { error } })
    throw new Error(error)
  }
  const markdown = await res.text()
  readmeCache.set(key, { at: Date.now(), data: { markdown } })
  return markdown
}

/**
 * Register the discovery HTTP routes.
 * @param host - Acquired webServer service.
 * @returns Disposer removing every registered route.
 */
export function mountDiscoveryRoutes(host: DiscoveryHost, listInstalled: () => string[]): () => void {
  const disposers = [
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-discovery/listing',
      handler: async (request, response) => {
        try {
          const url = new URL(request.url ?? '', 'http://localhost')
          if (url.searchParams.get('force') === '1') invalidateListing()
          const listing = await fetchListing()
          sendJson(response, 200, listing)
        } catch (error) {
          sendJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-discovery/installed',
      handler: async (_request, response) => {
        sendJson(response, 200, { installed: listInstalled() })
      },
    }),
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-discovery/search',
      handler: async (request, response) => {
        try {
          const url = new URL(request.url ?? '', 'http://localhost')
          const q = url.searchParams.get('q') ?? ''
          if (q.trim() === '') {
            sendJson(response, 400, { error: 'q is required' })
            return
          }
          const plugins = await fetchSearch(q)
          if (plugins === null) {
            sendJson(response, 502, { error: 'GitHub search unavailable' })
            return
          }
          sendJson(response, 200, { plugins, source: 'search' })
        } catch (error) {
          sendJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-discovery/readme',
      handler: async (request, response) => {
        try {
          const url = new URL(request.url ?? '', 'http://localhost')
          const owner = url.searchParams.get('owner') ?? ''
          const repo = url.searchParams.get('repo') ?? ''
          if (owner === '' || repo === '') {
            sendJson(response, 400, { error: 'owner and repo are required' })
            return
          }
          const markdown = await fetchReadme(owner, repo)
          sendJson(response, 200, { markdown })
        } catch (error) {
          sendJson(response, 404, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-discovery/plugin-status',
      handler: async (_request, response) => {
        try {
          // 拉 listing（TTL 缓存命中，不触发重拉）→ 用其插件列表启动/继续后台判定
          const listing = await fetchListing()
          const state = await startPluginScan(listing.plugins.map((p) => ({ owner: p.owner, repo: p.name })))
          sendJson(response, 200, state satisfies PluginScanState)
        } catch (error) {
          sendJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-discovery/settings',
      handler: async (request, response) => {
        try {
          if (request.method === 'PUT' || request.method === 'POST') {
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(chunk as Buffer)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { aiSummaryEnabled?: unknown }
            const settings = writeSettings({
              aiSummaryEnabled: typeof body.aiSummaryEnabled === 'boolean'
                ? body.aiSummaryEnabled
                : undefined,
            })
            sendJson(response, 200, settings)
            return
          }
          sendJson(response, 200, readSettings())
        } catch (error) {
          sendJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-discovery/security',
      handler: async (request, response) => {
        try {
          const url = new URL(request.url ?? '', 'http://localhost')
          const owner = url.searchParams.get('owner') ?? ''
          const repo = url.searchParams.get('repo') ?? ''
          if (owner === '' || repo === '') {
            sendJson(response, 400, { error: 'owner and repo are required' })
            return
          }
          const report = await scanRepositoryCached(owner, repo)
          sendJson(response, 200, report)
        } catch (error) {
          sendJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-discovery/installed-versions',
      handler: async (_request, response) => {
        try {
          const versions = await installedVersions(listInstalled)
          sendJson(response, 200, { plugins: versions })
        } catch (error) {
          sendJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

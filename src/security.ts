/**
 * dsh-discovery deterministic security pre-scan (L1).
 *
 * Read-only by design: fetches repo metadata / package.json / entry source as
 * text and applies static rules. Never executes remote code, never installs.
 *
 * The result is a structured signal list that the client hands to the LLM
 * reviewer as anchors — deterministic facts ("has a postinstall script",
 * "owner account is 5 days old", "dependency name resembles a known package")
 * that zero in on the danger zones, while the LLM makes the final call.
 *
 * Signal philosophy: facts are reported as-is; patterns are marked, not
 * condemned. A false positive costs the reviewer one extra look; a missed
 * supply-chain attack costs the machine.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const GITHUB_API = 'https://api.github.com'
const RAW_BASE = 'https://raw.githubusercontent.com'
const GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-discovery',
}
const FETCH_TIMEOUT_MS = 10000

export type SignalSeverity = 'info' | 'warn' | 'danger'
export type SignalCategory = 'script' | 'code' | 'dependency' | 'reputation' | 'metadata'
export type SecurityLevel = 'safe' | 'review' | 'caution'

export interface SecuritySignal {
  severity: SignalSeverity
  category: SignalCategory
  title: string
  /** 一句话说明 + 证据位置。 */
  detail: string
}

export interface SecurityEvidence {
  file: string
  snippet: string
}

export interface SecurityReport {
  owner: string
  repo: string
  scannedAt: string
  level: SecurityLevel
  signals: SecuritySignal[]
  /** 关键证据片段（scripts 内容 / 入口代码命中行），供 LLM 复核。 */
  evidence: SecurityEvidence[]
  /** package.json 摘要（null = 仓库无 package.json，可能不是 npm 包）。 */
  pkg: {
    main?: string
    bin?: string
    scripts?: Record<string, string>
    deps: string[]
  } | null
}

/* ── GitHub fetch helpers ─────────────────────────────────────────────────── */

async function ghJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** raw.githubusercontent 拉文本（不消耗 API 配额）。失败返回 null。 */
async function rawFile(owner: string, repo: string, branch: string, path: string): Promise<string | null> {
  try {
    const res = await fetch(`${RAW_BASE}/${owner}/${repo}/${branch}/${path}`, {
      headers: { 'user-agent': 'dsh-discovery' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

interface RepoMeta {
  defaultBranch: string
  createdAt: string
  ownerType: 'org' | 'user' | null
  ownerLogin: string
}

interface UserMeta {
  createdAt: string
  followers: number
  publicRepos: number
}

/** 仓库元数据 + owner 账号信息（2 次 API 请求，TTL 缓存 24h）。 */
const metaCache = new Map<string, { at: number; data: { repo: RepoMeta | null; user: UserMeta | null } }>()
const META_TTL_MS = 24 * 60 * 60 * 1000

async function fetchMeta(owner: string, repo: string): Promise<{ repo: RepoMeta | null; user: UserMeta | null }> {
  const key = `${owner}/${repo}`
  const cached = metaCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < META_TTL_MS) return cached.data
  const repoJson = await ghJson<{
    default_branch?: string
    created_at?: string
    owner?: { type?: string; login?: string }
  }>(`${GITHUB_API}/repos/${owner}/${repo}`)
  const repoMeta: RepoMeta | null = repoJson === null
    ? null
    : {
        defaultBranch: repoJson.default_branch ?? 'main',
        createdAt: repoJson.created_at ?? '',
        ownerType: repoJson.owner?.type === 'Organization' ? 'org' : repoJson.owner?.type === 'User' ? 'user' : null,
        ownerLogin: repoJson.owner?.login ?? owner,
      }
  const userJson = await ghJson<{ created_at?: string; followers?: number; public_repos?: number }>(
    `${GITHUB_API}/users/${encodeURIComponent(owner)}`,
  )
  const user: UserMeta | null = userJson === null
    ? null
    : {
        createdAt: userJson.created_at ?? '',
        followers: userJson.followers ?? 0,
        publicRepos: userJson.public_repos ?? 0,
      }
  const data = { repo: repoMeta, user }
  metaCache.set(key, { at: Date.now(), data })
  return data
}

/* ── package.json 解析 ────────────────────────────────────────────────────── */

interface PkgShape {
  main?: string
  bin?: string | Record<string, string>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function extractEntryPaths(pkg: PkgShape): string[] {
  const paths: string[] = []
  if (typeof pkg.main === 'string') paths.push(pkg.main)
  if (typeof pkg.bin === 'string') paths.push(pkg.bin)
  if (typeof pkg.bin === 'object' && pkg.bin !== null) paths.push(...Object.values(pkg.bin))
  return paths.filter((p) => p !== '' && !p.startsWith('.')).slice(0, 5)
}

/** scripts 值里引用的本地脚本文件（如 "node scripts/check.js"）。 */
function extractScriptFiles(scripts: Record<string, string>): string[] {
  const files = new Set<string>()
  for (const value of Object.values(scripts)) {
    for (const token of value.split(/\s+/)) {
      const m = token.match(/^([.\w\/-]+\.(?:js|cjs|mjs|ts|sh|ps1|py))$/)
      if (m !== null && token.includes('/')) files.add(token)
    }
  }
  return [...files].slice(0, 5)
}

/* ── static rule engine ───────────────────────────────────────────────────── */

const INSTALL_SCRIPT_KEYS = ['install', 'postinstall', 'preinstall', 'prepare', 'preprepare']

/** 下载并执行的模式（curl|wget → sh|bash|powershell）。 */
const DOWNLOAD_EXEC = /(curl|wget|iwr|invoke-webrequest)[^\n|;]*(\||\s+-\s*|\s+)[-]?[oO]?\s*[^\n]*(\|\s*)?(sh|bash|powershell|pwsh|node|python)/i
/** 内联代码执行。 */
const INLINE_EXEC = /\b(node|python|perl|ruby|php)\s+-[a-z]+\s+/i
/** 写入敏感路径（home 之外的配置文件 / ssh 密钥）。 */
const WRITE_SENSITIVE = /(?:~\/|%USERPROFILE%\\|\/home\/|\/root\/|C:\\Users\\)[^\s'"]*\.(?:ssh|bashrc|zshrc|profile|env|netrc|aws|kube|docker)(?:[\/\\\s]|$)/i
/** 读密钥 / 环境变量。 */
const READ_SECRET = /(?:\.env|\.npmrc|\.pypirc|aws\/(?:credentials|config)|\.ssh\/id_|GITHUB_TOKEN|DEEPSEEK_API_KEY|OPENAI_API_KEY|sk-[A-Za-z0-9]{16,})/i
/** 代码中的动态执行。 */
const CODE_EVAL = /\b(?:eval|new Function|vm\.runIn|Function\()\s*\(/i
const CODE_EXEC = /\b(?:child_process|execSync|execFileSync|spawnSync|\.exec\s*\(|\.spawn\s*\()/i
/** base64 解码 + 执行组合。 */
const BASE64_EXEC = /(?:atob\s*\(|Buffer\.from\s*\([^)]*base64|fromBase64)[\s\S]{0,200}(?:eval|exec|Function|require)/i

/** 外链白名单：常规包源/官方域名，命中不算可疑。 */
const ALLOWED_HOSTS = new Set([
  'github.com', 'raw.githubusercontent.com', 'api.github.com',
  'registry.npmjs.org', 'www.npmjs.com', 'npmjs.com', 'cdn.jsdelivr.net',
  'registry.npmmirror.com', 'npmmirror.com', 'unpkg.com', 'esm.sh',
  'deepseek.com', 'api.deepseek.com', 'huggingface.co', 'pypi.org', 'files.pythonhosted.org',
])
const URL_RE = /(?:https?:\/\/)([^\s"')\]]+)/gi

function extractHosts(text: string): string[] {
  const hosts = new Set<string>()
  for (const m of text.matchAll(URL_RE)) {
    try {
      const host = new URL(m[1]).hostname
      if (host !== '') hosts.add(host)
    } catch {
      // 非法 URL 忽略
    }
  }
  return [...hosts].filter((h) => !ALLOWED_HOSTS.has(h))
}

/* typosquatting：与核心生态包名相似（编辑距离 ≤ 2）。 */
const CORE_PACKAGES = [
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/cordis', 'cordis', '@koishijs/core', 'koishi',
]
const TYPO_LIMIT = 2

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i += 1) dp[i][0] = i
  for (let j = 0; j <= n; j += 1) dp[0][j] = j
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

function nearCorePackage(name: string): string | null {
  const plain = name.replace(/^@[^/]+\//, '')
  for (const core of CORE_PACKAGES) {
    const corePlain = core.replace(/^@[^/]+\//, '')
    if (name === core) continue
    if (levenshtein(plain, corePlain) <= TYPO_LIMIT && plain !== corePlain) return core
  }
  return null
}

function daysBetween(iso: string, now: number): number {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now - t) / 86_400_000)
}

/* ── main scan ────────────────────────────────────────────────────────────── */

export async function scanRepository(owner: string, repo: string): Promise<SecurityReport> {
  const signals: SecuritySignal[] = []
  const evidence: SecurityEvidence[] = []
  const now = Date.now()

  // 1) 元数据信誉（确定性事实）
  const { repo: meta, user } = await fetchMeta(owner, repo)
  if (meta === null) {
    // 仓库元数据拉取失败（404 或网络异常）：不判 safe——明确告警「预检不完整」
    signals.push({
      severity: 'warn',
      category: 'metadata',
      title: '仓库元数据获取失败，预检不完整',
      detail: '无法从 GitHub 获取仓库/owner 信息（仓库可能不存在，或网络/代理异常）。本次预检未覆盖脚本、代码与依赖扫描，请人工审查。',
    })
    return { owner, repo, scannedAt: new Date().toISOString(), level: 'review', signals, evidence, pkg: null }
  }
  const branch = meta.defaultBranch
  const repoAge = meta.createdAt === '' ? Number.POSITIVE_INFINITY : daysBetween(meta.createdAt, now)
  if (repoAge < 30) {
    signals.push({
      severity: 'warn',
      category: 'reputation',
      title: '仓库创建不足 30 天',
      detail: `创建于 ${meta.createdAt.slice(0, 10)}（约 ${Math.floor(repoAge)} 天前）。新仓库 + 高关注度是恶意分发的常见组合，请重点核对。`,
    })
  }
  if (meta.ownerType === 'user') {
    signals.push({
      severity: 'info',
      category: 'reputation',
      title: '个人账号仓库',
      detail: 'owner 为个人账号（非组织）。组织发布的插件有实体背书，个人账号请结合账号年龄与仓库活跃度判断。',
    })
  }
  if (user !== null && user.createdAt !== '') {
    const accountAge = daysBetween(user.createdAt, now)
    if (accountAge < 90) {
      signals.push({
        severity: 'danger',
        category: 'reputation',
        title: 'owner 账号创建不足 90 天',
        detail: `账号注册于 ${user.createdAt.slice(0, 10)}（约 ${Math.floor(accountAge)} 天前），followers=${user.followers}，public_repos=${user.publicRepos}。全新账号发布插件是恶意分发的高置信特征。`,
      })
    } else if (accountAge < 365 && (user.followers ?? 0) < 5) {
      signals.push({
        severity: 'warn',
        category: 'reputation',
        title: '账号较新且关注度低',
        detail: `账号 ${Math.floor(accountAge)} 天，followers=${user.followers}。无社区影响力的新账号发布插件需谨慎。`,
      })
    }
  }

  // 2) package.json：scripts / 依赖（供应链攻击主战场）
  const pkgText = await rawFile(owner, repo, branch, 'package.json')
  let pkg: SecurityReport['pkg'] = null
  if (pkgText === null) {
    signals.push({
      severity: 'warn',
      category: 'metadata',
      title: '未找到 package.json',
      detail: '仓库根目录无 package.json，可能不是标准 npm 插件包。请确认其安装方式与入口。',
    })
  } else {
    let parsed: PkgShape | null = null
    try {
      parsed = JSON.parse(pkgText) as PkgShape
    } catch {
      signals.push({
        severity: 'danger',
        category: 'metadata',
        title: 'package.json 无法解析',
        detail: 'package.json 不是合法 JSON，属于异常结构，请人工核对。',
      })
    }
    if (parsed !== null) {
      const scripts = parsed.scripts ?? {}
      const deps = [
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
        ...Object.keys(parsed.peerDependencies ?? {}),
      ]
      pkg = {
        main: parsed.main,
        bin: typeof parsed.bin === 'string' ? parsed.bin : undefined,
        scripts: Object.keys(scripts).length > 0 ? scripts : undefined,
        deps,
      }
      // 2a) 安装时自动执行的脚本
      const installScripts = Object.entries(scripts).filter(([k]) => INSTALL_SCRIPT_KEYS.includes(k))
      if (installScripts.length > 0) {
        for (const [key, value] of installScripts) {
          const snippet = value.slice(0, 400)
          evidence.push({ file: 'package.json', snippet: `"${key}": "${value}"` })
          if (DOWNLOAD_EXEC.test(value)) {
            signals.push({
              severity: 'danger',
              category: 'script',
              title: `${key} 脚本存在「下载并执行」模式`,
              detail: `安装时自动下载并执行远程代码是供应链投毒的头号入口。脚本内容：${snippet}`,
            })
          } else if (WRITE_SENSITIVE.test(value) || READ_SECRET.test(value)) {
            signals.push({
              severity: 'danger',
              category: 'script',
              title: `${key} 脚本触碰敏感路径/密钥`,
              detail: `脚本内容涉及写入敏感文件或读取密钥。脚本内容：${snippet}`,
            })
          } else if (INLINE_EXEC.test(value)) {
            signals.push({
              severity: 'warn',
              category: 'script',
              title: `${key} 脚本包含内联代码执行`,
              detail: `安装时执行内联代码。脚本内容：${snippet}`,
            })
          } else {
            signals.push({
              severity: 'warn',
              category: 'script',
              title: `存在 ${key} 安装脚本（内容需人工复核）`,
              detail: `脚本内容：${snippet}`,
            })
          }
        }
      }
      // 2b) 可疑外链
      const hosts = extractHosts(pkgText)
      if (hosts.length > 0) {
        signals.push({
          severity: 'warn',
          category: 'code',
          title: 'package.json 中发现非白名单外链',
          detail: `外链域名：${hosts.join(', ')}。请确认这些域名的用途。`,
        })
      }
      // 2c) 依赖数量异常
      if (deps.length > 50) {
        signals.push({
          severity: 'warn',
          category: 'dependency',
          title: `依赖数量偏多（${deps.length} 个）`,
          detail: '插件通常依赖较少。大量依赖增大供应链投毒面，请核对依赖清单。',
        })
      }
      // 2d) typosquatting（排除 @types/*——DefinitelyTyped 官方类型包，与核心包编辑距离恰好 ≤2 属正常）
      for (const dep of deps) {
        if (dep.startsWith('@types/')) continue
        const near = nearCorePackage(dep)
        if (near !== null) {
          signals.push({
            severity: 'warn',
            category: 'dependency',
            title: `依赖名与核心包相似（typosquatting 嫌疑）：${dep}`,
            detail: `与 ${near} 相似（编辑距离 ≤ ${TYPO_LIMIT}）。若为误导性拼写，安装时可能引入同名恶意包。`,
          })
        }
      }
      // 2e) file:/git: 本地引用
      const localRefs = deps.filter((d) => {
        const spec = { ...parsed.dependencies, ...parsed.devDependencies, ...parsed.peerDependencies }[d]
        return typeof spec === 'string' && (spec.startsWith('file:') || spec.startsWith('git:') || spec.startsWith('github:'))
      })
      if (localRefs.length > 0) {
        signals.push({
          severity: 'info',
          category: 'dependency',
          title: '依赖含本地/仓库引用',
          detail: `本地引用依赖：${localRefs.join(', ')}。file:/github: 引用绕过 npm 审计，请确认来源。`,
        })
      }
    }
  }

  // 3) 入口 + 脚本文件代码模式扫描
  const scanFiles: string[] = []
  if (pkg !== null) {
    scanFiles.push(...extractEntryPaths({ main: pkg.main, bin: pkg.bin, scripts: pkg.scripts }))
    if (pkg.scripts !== undefined) scanFiles.push(...extractScriptFiles(pkg.scripts))
  }
  const uniqueFiles = [...new Set(scanFiles)].filter((p) => p !== 'package.json').slice(0, 8)
  for (const file of uniqueFiles) {
    const code = await rawFile(owner, repo, branch, file)
    if (code === null || code.length > 100_000) continue
    /** 命中处上下文片段（用于 evidence）。 */
    const snippetAt = (idx: number | undefined, extra = 120): string =>
      code.slice(Math.max(0, (idx ?? 0) - 60), (idx ?? 0) + extra).replace(/\n/g, ' ').slice(0, 200)
    const evalMatch = code.match(CODE_EVAL)
    if (evalMatch !== null) {
      evidence.push({ file, snippet: snippetAt(evalMatch.index) })
      signals.push({ severity: 'warn', category: 'code', title: `${file} 包含动态代码执行（eval/Function）`, detail: '动态执行可隐藏反混淆后的恶意逻辑，请查看上下文。' })
    }
    const execMatch = code.match(CODE_EXEC)
    if (execMatch !== null) {
      evidence.push({ file, snippet: snippetAt(execMatch.index) })
      signals.push({ severity: 'warn', category: 'code', title: `${file} 包含子进程执行（child_process/spawn/exec）`, detail: '插件内启动子进程需重点确认命令内容与参数来源。' })
    }
    const writeMatch = code.match(WRITE_SENSITIVE)
    if (writeMatch !== null) {
      evidence.push({ file, snippet: snippetAt(writeMatch.index) })
      signals.push({ severity: 'danger', category: 'code', title: `${file} 写入敏感路径（~/.ssh、bashrc 等）`, detail: '插件启动时改写用户 shell/ssh 配置是持久化后门的典型行为。' })
    }
    const secretMatch = code.match(READ_SECRET)
    if (secretMatch !== null) {
      evidence.push({ file, snippet: snippetAt(secretMatch.index) })
      signals.push({ severity: 'warn', category: 'code', title: `${file} 读取密钥/环境变量文件`, detail: '读取 .env / API key / 云凭据需确认用途（正常插件读取 API key 属合理，重点是是否外发）。' })
    }
    if (BASE64_EXEC.test(code)) {
      signals.push({ severity: 'danger', category: 'code', title: `${file} 存在 base64 解码后执行的模式`, detail: '编码混淆 + 执行是规避静态检测的经典手法，务必查看解码目标。' })
    }
    const hosts = extractHosts(code)
    if (hosts.length > 0) {
      signals.push({
        severity: 'warn',
        category: 'code',
        title: `${file} 请求非白名单域名：${hosts.join(', ')}`,
        detail: '插件外发数据前请确认域名归属与传输内容（遥测上报 vs 数据窃取）。',
      })
    }
  }

  // 4) 汇总评级
  const hasDanger = signals.some((s) => s.severity === 'danger')
  const hasWarn = signals.some((s) => s.severity === 'warn')
  const level: SecurityLevel = hasDanger ? 'caution' : hasWarn ? 'review' : 'safe'

  return { owner, repo, scannedAt: new Date().toISOString(), level, signals, evidence, pkg }
}

/* ── 扫描结果缓存（按需触发，TTL 24h） ────────────────────────────────────── */

const scanCache = new Map<string, { at: number; data: SecurityReport }>()
const SCAN_TTL_MS = 24 * 60 * 60 * 1000

export async function scanRepositoryCached(owner: string, repo: string): Promise<SecurityReport> {
  const key = `${owner}/${repo}`
  const cached = scanCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < SCAN_TTL_MS) return cached.data
  const report = await scanRepository(owner, repo)
  // 仅缓存「完整预检」结果（meta 拉取失败时报告无信号无 pkg，不缓存——避免把预检不完整固化成安全）
  if (report.signals.length > 0 || report.pkg !== null) {
    scanCache.set(key, { at: Date.now(), data: report })
  }
  return report
}

export function invalidateScanCache(): void {
  scanCache.clear()
}

/**
 * dsh-discovery host entry: mounts a read-only registry route that lists
 * community DSH plugins from the GitHub `dsh-plugin` topic. Deliberately no
 * install / update / restart endpoints — installation is left to the user or
 * the host agent after reviewing a repository (dsh plugin add).
 *
 * Agent integration (two channels):
 * - A: dynamic system-prompt summary — the section text is a function evaluated
 *      at every assembly, so the agent always knows the ecosystem state
 *      (plugin counts, installed plugins, verdict stats).
 * - B: two agent tools — `dsh_discovery_search` (search the registry) and
 *      `dsh_discovery_audit` (deterministic security pre-scan of a repo).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  fetchListing, getCachedListing, mountDiscoveryRoutes,
  type DiscoveryHost, type PluginEntry,
} from './routes.ts'
import { scanRepositoryCached } from './security.ts'
import { getPluginScanStateSync, getPluginVerdictCounts } from './plugin-check.ts'

export const name = 'dsh-discovery'

/** Minimal host-plane systemPrompt service face (avoids a hard dep on @deepseek-ai/dsh-system-prompt). */
interface SystemPromptFace {
  section(section: { name: string; order: number; text: string | (() => string) }): () => void
}

/** 内置 bundle 插件（非用户安装），已安装标识中排除。 */
const BUILTIN_PLUGINS = new Set([
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
  'dsh-about', // dsh-gui 内置组件（设置→关于），随 GUI 发布，不走插件更新
])

/** 当前激活 profile 名（host 启动 argv：node bin.js --profile <name>）。 */
function resolveProfileName(): string {
  const idx = process.argv.indexOf('--profile')
  return idx >= 0 && process.argv[idx + 1] !== undefined ? process.argv[idx + 1] : 'web'
}

/** 读 profile manifest 的 dsh.profile.bundles，过滤内置，得到用户安装的插件包名。 */
function listInstalledPlugins(): string[] {
  try {
    const manifestPath = join(homedir(), '.dsh', 'profiles', resolveProfileName(), 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dsh?: { profile?: { bundles?: string[] } }
    }
    return (manifest.dsh?.profile?.bundles ?? []).filter((name) => !BUILTIN_PLUGINS.has(name))
  } catch {
    return []
  }
}

/** 机制 A：每次 system prompt 组装时实时求值的生态摘要（同步读缓存，~200 token）。 */
function renderDiscoverySummary(): string {
  const installed = listInstalledPlugins()
  const verdicts = getPluginVerdictCounts()
  const listing = getCachedListing()
  const total = listing?.plugins.length
  return [
    'Installed plugin: dsh-discovery — DSH 社区插件搜索器（浏览 GitHub dsh-plugin 话题社区插件）。',
    total !== undefined
      ? `社区生态：${total} 个仓库，已确定性确认插件 ${verdicts.plugins} 个、非插件 ${verdicts.notPlugins} 个。`
      : '社区生态：尚未拉取（可调用 dsh_discovery_search 获取）。',
    installed.length > 0 ? `已安装插件：${installed.join(', ')}` : '已安装插件：无。',
    '可用工具：dsh_discovery_search（关键词搜索社区插件，返回星级/插件判定/信誉信号）、dsh_discovery_audit（对插件仓库做确定性安全预检，输出风险报告）。',
    '安全铁律：第三方插件未经官方审计——安装任何新插件前必须先调用 dsh_discovery_audit 预检；预检与审查只是预防措施，对异常行为保持警惕，不向插件泄露敏感信息。',
  ].join('\n')
}

export function apply(ctx: Context): void {
  ctx.inject(['systemPrompt'], (sysCtx: Context) => (sysCtx as unknown as { systemPrompt: SystemPromptFace }).systemPrompt.section({
    name: 'plugin:dsh-discovery',
    order: 900,
    text: renderDiscoverySummary,
  }))
  ctx.inject(['webServer', 'loader'], (hostCtx: Context) => {
    const host = hostCtx as unknown as DiscoveryHost
    host.effect(() => mountDiscoveryRoutes(host, listInstalledPlugins), 'dsh-discovery: http routes')
  })
  // 机制 B：注册 agent 工具——搜索 + 安全预检
  ctx.inject(['tools'], (toolsCtx: Context) => {
    const tools = (toolsCtx as unknown as { tools: { register(tool: unknown): void } }).tools
    tools.register(defineTool({
      name: 'dsh_discovery_search',
      description: 'Search the DSH community plugin registry (GitHub dsh-plugin topic). Returns plugins matching the query with stars, plugin-verdict (plugin/not/unknown) and reputation signals (ownerType). Use when the user asks what plugins exist, wants to find a plugin for a capability, or before recommending an install.',
      parameters: {
        query: { type: 'string', description: 'Keyword matched against plugin name / owner / description. Chinese keywords auto-map to English synonyms (e.g. 记忆/通知/模型).' },
        limit: { type: 'integer', description: 'Max results to return (default 20, cap 50).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer', required: true },
            plugins: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  owner: { type: 'string', required: true },
                  stars: { type: 'integer', required: true },
                  isPlugin: { type: 'string', required: true, description: "'plugin' | 'not' | null(未判定，字符串表示)" },
                  ownerType: { type: 'string', required: true, description: "'org' | 'user' | null(字符串表示)" },
                  description: { type: 'string', required: true },
                  htmlUrl: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const listing = await fetchListing()
        const q = (args.query ?? '').trim().toLowerCase()
        const limit = Math.min(args.limit ?? 20, 50)
        const verdicts = getPluginScanStateSync().statuses
        const matched = listing.plugins
          .filter((p) => q === '' || `${p.name} ${p.owner} ${p.description}`.toLowerCase().includes(q))
          .slice(0, limit)
          .map((p) => ({
            name: p.name,
            owner: p.owner,
            stars: p.stars,
            isPlugin: verdicts[`${p.owner}/${p.name}`] ?? 'unknown',
            ownerType: p.ownerType ?? 'unknown',
            description: (p.description ?? '').slice(0, 120),
            htmlUrl: p.htmlUrl,
          }))
        return { total: matched.length, plugins: matched }
      },
    }))
    tools.register(defineTool({
      name: 'dsh_discovery_audit',
      description: 'Deterministic security pre-scan of a plugin repository BEFORE installation: fetches repo metadata + package.json + entry/script code and runs static rules (install scripts with download-execute, sensitive-path writes, secret reads, child_process/eval, dependency typosquatting, owner reputation, star/fork farming). Returns a risk report (level: safe/review/caution) with signals and evidence snippets. MUST be called before installing any third-party plugin, and the evidence must be re-checked by reading the actual code.',
      parameters: {
        owner: { type: 'string', required: true, description: 'GitHub owner, e.g. "deepseek-ai".' },
        repo: { type: 'string', required: true, description: 'GitHub repository name, e.g. "dsh-market".' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            level: { type: 'string', required: true, description: "'safe' | 'review' | 'caution'" },
            signals: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  severity: { type: 'string', required: true, description: "'info' | 'warn' | 'danger'" },
                  category: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  detail: { type: 'string', required: true },
                },
              },
            },
            evidence: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  file: { type: 'string', required: true },
                  snippet: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const report = await scanRepositoryCached(args.owner, args.repo)
        return { level: report.level, signals: report.signals, evidence: report.evidence }
      },
    }))
  })
}

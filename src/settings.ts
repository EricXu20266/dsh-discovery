/**
 * dsh-discovery per-profile settings, persisted to disk so the host-side
 * system-prompt summary and the client-side toggles share one source of truth.
 *
 * The AI summary costs tokens on every prompt assembly, so it has an
 * on/off switch (default ON). Settings live in
 * `~/.dsh/profiles/<profile>/dsh-discovery-settings.json`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DiscoverySettings {
  /** 机制 A：是否向 agent 注入社区生态摘要（每次 prompt 组装消耗 ~200 token）。默认开。 */
  aiSummaryEnabled: boolean
}

const DEFAULTS: DiscoverySettings = { aiSummaryEnabled: true }

/** 当前激活 profile 名（与 host 侧一致：argv --profile）。 */
function resolveProfileName(): string {
  const idx = process.argv.indexOf('--profile')
  return idx >= 0 && process.argv[idx + 1] !== undefined ? process.argv[idx + 1] : 'web'
}

function settingsPath(): string {
  return join(homedir(), '.dsh', 'profiles', resolveProfileName(), 'dsh-discovery-settings.json')
}

/** 读设置（文件缺失/损坏 → 默认值）。 */
export function readSettings(): DiscoverySettings {
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<DiscoverySettings>
    return {
      aiSummaryEnabled: typeof parsed.aiSummaryEnabled === 'boolean'
        ? parsed.aiSummaryEnabled
        : DEFAULTS.aiSummaryEnabled,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** 写设置（部分更新，返回合并后的完整设置）。 */
export function writeSettings(partial: Partial<DiscoverySettings>): DiscoverySettings {
  const current = readSettings()
  const next: DiscoverySettings = { ...current, ...partial }
  try {
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // 设置写失败不影响主流程（回退为内存态）
  }
  return next
}

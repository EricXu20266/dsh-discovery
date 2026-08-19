/**
 * dsh-discovery client: the sidebar entry (under New Session) opens a
 * full-screen discovery browser. Read-only by design — listing comes from the
 * host's read-only GitHub proxy, and opening a repo is a plain external link.
 * There is deliberately no install / update / uninstall surface here:
 * installation happens via `dsh plugin add` after the user reviews a repo.
 */
import { createElement as h, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Translate } from './locales-types.ts'
import { zh, en } from './locales.ts'
import {
  filterPlugins, orderedCategories, isOfficial, suspiciousStars, SCENARIOS, scenarioPlugins,
  type PluginEntry, type PluginListing, type Scenario, type InstalledVersion,
} from './market-data.ts'
import type { SecurityReport, SecuritySignal } from '../security.ts'
import type { PluginScanState } from '../plugin-check.ts'

export const name = 'dsh-discovery'
// Locale + slots + session orchestration injected before apply runs.
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

/** Listing 缓存：sessionStorage（关闭标签页 = app 重启即清空）+ TTL 定时过期。 */
const LISTING_TTL_MS = 10 * 60 * 1000
const LISTING_CACHE_KEY = 'dshd.listing.cache.v1'
/** 「只看插件」视图偏好（localStorage，跨会话保留）。 */
const ONLY_PLUGINS_KEY = 'dshd.onlyPlugins'

function readListingCache(): PluginListing | null {
  try {
    const raw = sessionStorage.getItem(LISTING_CACHE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { at: number; data: PluginListing }
    // 空列表缓存忽略（可能是瞬时拉取失败被固化）——视同无缓存，重新拉取
    if (parsed.data.plugins.length === 0) return null
    return Date.now() - parsed.at < LISTING_TTL_MS ? parsed.data : null
  } catch {
    return null
  }
}

function writeListingCache(data: PluginListing): void {
  try {
    // 空列表不写缓存：避免把瞬时失败/空结果固化（用户会看到「没有匹配的插件」且 10 分钟内无法恢复）
    if (data.plugins.length === 0) return
    sessionStorage.setItem(LISTING_CACHE_KEY, JSON.stringify({ at: Date.now(), data }))
  } catch {
    // storage 不可用（隐私模式等）时静默降级为每次拉取
  }
}

export interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
  subscribe(callback: () => void): () => void
  getSnapshot(): { active: string }
}

export interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: () => unknown): unknown
}

export interface SessionsService {
  list: { getSnapshot(): { current?: string } }
  open(id: string): void
  scope(id: string): { get(name: string): unknown } | undefined
}

export interface WorkspacesService {
  list: {
    getSnapshot(): {
      items: Array<{ sessionIds: string[]; workspaceId: string }>
      recentWorkspaceId?: string
    }
  }
  startSession(workspaceId?: string): void
  connectWorkspace(workspaceId: string): Promise<string>
}

export interface DiscoveryClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
  sessions: SessionsService
  workspaces: WorkspacesService
}

/** DHS ui-primitives IconCordisPluginOutline14 path (linear plugin glyph). */
const PLUGIN_ICON_PATH = 'M3.03426 5.66661L1.70084 7.00003L3.0315 8.33069L2.14762 9.21457L-0.0669245 7.00003L2.15038 4.78273L3.03426 5.66661ZM7 14.067L4.77924 11.8462L5.66313 10.9623L7 12.2992L8.33342 10.9658L9.2173 11.8496L7 14.067ZM11.8489 9.21803L10.965 8.33414L12.2992 7.00003L10.9623 5.66316L11.8462 4.77927L14.0669 7.00003L11.8489 9.21803ZM8.33066 3.03153L7 1.70087L5.66589 3.03498L4.782 2.1511L7 -0.0668945L9.21454 2.14765L8.33066 3.03153Z'

function PluginIcon({ size = 14 }: { size?: number }) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 14 14', fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg', style: { flexShrink: 0 },
  },
    h('g', { clipPath: 'url(#dshd-plug-clip)' },
      h('path', { d: PLUGIN_ICON_PATH, fill: 'currentColor' }),
      h('rect', { x: 5.98535, y: 5.98535, width: 2.02942, height: 2.02942, fill: 'currentColor' }),
    ),
    h('defs', null, h('clipPath', { id: 'dshd-plug-clip' }, h('rect', { width: 14, height: 14, fill: 'currentColor' }))),
  )
}

/* ── inline styles (consistent with the taishen-style panel look) ─────────── */

const btnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  width: '100%', height: 38, padding: '8px 16px', boxSizing: 'border-box',
  background: 'transparent', border: 'none', borderRadius: 12,
  color: 'var(--dsw-alias-label-primary, #c6c8d4)', font: '500 14px system-ui',
  lineHeight: '22px', cursor: 'pointer', textAlign: 'left', overflow: 'hidden',
  transition: 'background-color .15s ease, color .15s ease, transform .15s ease',
}
const btnHoverStyle: React.CSSProperties = {
  background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))',
  color: 'var(--dsw-alias-label-primary, #e0e0f0)',
}
const railStyle: React.CSSProperties = {
  ...btnStyle, justifyContent: 'center', width: 36, height: 36, padding: 0, borderRadius: 8,
  color: 'var(--dsw-alias-label-secondary, #9aa0b4)',
}
const maskStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(8,8,16,.6)', zIndex: 1000 }
const panelStyle: React.CSSProperties = {
  position: 'absolute', inset: '28px 32px', maxWidth: 1180, margin: '0 auto',
  background: 'var(--dsw-alias-bg-layer-1, #14141f)',
  border: '1px solid var(--dsw-alias-border-l2, #2e2e4a)', borderRadius: 16,
  boxShadow: '0 24px 64px rgba(0,0,0,.5)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
}
const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px',
  color: 'var(--dsw-alias-label-primary, #e0e0f0)', font: '600 15px system-ui', flexShrink: 0,
}
const closeStyle: React.CSSProperties = {
  marginLeft: 'auto', background: 'var(--dsw-alias-button-elevated-fill, #2a2a4a)',
  color: 'var(--dsw-alias-label-primary, #e0e0f0)', border: '1px solid var(--dsw-alias-border-l2, #3a3a5a)',
  borderRadius: 6, padding: '4px 12px', cursor: 'pointer', font: '12px system-ui',
}
const bodyStyle: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: '16px 20px 24px' }
const searchStyle: React.CSSProperties = {
  width: '100%', padding: '8px 12px', borderRadius: 8, boxSizing: 'border-box',
  border: '1px solid var(--dsw-alias-border-l2, #3a3a5a)',
  background: 'var(--dsw-alias-bg-layer-2, #1c1c2e)', color: 'var(--dsw-alias-label-primary, #e0e0f0)',
  font: '13px system-ui', outline: 'none', marginBottom: 12,
}
const catRowStyle: React.CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }
const catStyle: React.CSSProperties = {
  border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary, #9aa0b4)',
  fontSize: 12, padding: '4px 12px', borderRadius: 999, cursor: 'pointer',
  transition: 'background-color .15s ease, color .15s ease',
}
const catOnStyle: React.CSSProperties = {
  ...catStyle, background: 'var(--dsw-alias-bg-layer-2, #2a2a4a)',
  color: 'var(--dsw-alias-brand-primary, #7aa2ff)', fontWeight: 600,
}
const gridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }
const onlineNoteStyle: React.CSSProperties = {
  fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary, #7c7c9c)',
  background: 'var(--dsw-alias-bg-layer-2, #1c1c2e)', borderRadius: 8, padding: '6px 12px', marginBottom: 12,
}
const cardStyle: React.CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1, #1a1a2b)',
  border: '1px solid var(--dsw-alias-border-l2, #2e2e4a)', borderRadius: 12, padding: '14px 16px',
  display: 'flex', flexDirection: 'column', gap: 8, transition: 'border-color .15s ease, transform .15s ease',
}
const nameStyle: React.CSSProperties = {
  fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #e0e0f0)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const ownerStyle: React.CSSProperties = { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #7c7c9c)' }
const descStyle: React.CSSProperties = {
  fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #9aa0b4)',
  minHeight: 36, margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
}
const metaStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--dsw-alias-label-secondary, #7c7c9c)', marginTop: 'auto' }
const repoBtnStyle: React.CSSProperties = {
  marginLeft: 'auto', border: '1px solid var(--dsw-alias-border-l2, #3a3a5a)',
  background: 'var(--dsw-alias-button-elevated-fill, #2a2a4a)',
  color: 'var(--dsw-alias-label-primary, #e0e0f0)', borderRadius: 6,
  padding: '4px 10px', cursor: 'pointer', fontSize: 11, textDecoration: 'none',
  transition: 'border-color .15s ease, background-color .15s ease',
}
const disclaimerStyle: React.CSSProperties = {
  fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #7c7c9c)',
  background: 'var(--dsw-alias-bg-layer-2, #1c1c2e)', borderRadius: 8, padding: '8px 12px', margin: '0 0 12px',
}
const loadingStyle: React.CSSProperties = { textAlign: 'center', color: 'var(--dsw-alias-label-secondary, #9aa0b4)', fontSize: 13, padding: 48 }
const emptyStyle: React.CSSProperties = { textAlign: 'center', color: 'var(--dsw-alias-label-secondary, #9aa0b4)', fontSize: 13, padding: 32 }

const badgeOfficialStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 600,
  color: '#ffffff', padding: '2px 8px', borderRadius: 999, lineHeight: '16px',
  background: 'var(--dsw-static-deepseek-500, #4176E6)', flexShrink: 0,
}
const badgeThirdStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 600,
  color: 'var(--dsw-alias-label-tertiary, #7c7c9c)', padding: '1px 7px', borderRadius: 999, lineHeight: '16px',
  border: '1px solid currentColor', flexShrink: 0,
}
/** L0 信誉信号徽章：个人账号（非组织非官方）。 */
const badgePersonalStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 600,
  color: '#c084fc', padding: '1px 7px', borderRadius: 999, lineHeight: '16px',
  border: '1px solid currentColor', flexShrink: 0,
}
/** L0 信誉信号徽章：星数/fork 比异常（疑似刷星）。 */
const badgeStarAnomalyStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 600,
  color: '#f97316', padding: '1px 7px', borderRadius: 999, lineHeight: '16px',
  border: '1px solid currentColor', flexShrink: 0,
}
/** 确定性插件判定徽章：确认为 DSH 插件。 */
const badgePluginStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 600,
  color: '#22c55e', padding: '1px 7px', borderRadius: 999, lineHeight: '16px',
  border: '1px solid currentColor', flexShrink: 0,
}
/** 确定性插件判定徽章：确认为非插件。 */
const badgeNotPluginStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 600,
  color: '#9ca3af', padding: '1px 7px', borderRadius: 999, lineHeight: '16px',
  border: '1px solid currentColor', flexShrink: 0,
}
/* ── toggle switch（滑块）────────────────────────────────────────────────── */
const toggleStyle: React.CSSProperties = {
  position: 'relative', width: 38, height: 22, borderRadius: 11, flexShrink: 0, cursor: 'pointer',
  background: 'var(--dsw-alias-bg-layer-2, #2a2a4a)',
  border: '1px solid var(--dsw-alias-border-l2, #3a3a5a)', padding: 0,
  transition: 'background-color .2s ease, border-color .2s ease',
}
const toggleOnStyle: React.CSSProperties = {
  ...toggleStyle,
  background: 'var(--dsw-static-deepseek-500, #4176E6)',
  borderColor: 'var(--dsw-static-deepseek-500, #4176E6)',
}
const toggleKnobStyle: React.CSSProperties = {
  position: 'absolute', top: 2, left: 2, width: 16, height: 16, borderRadius: '50%',
  background: '#fff', transition: 'left .2s ease',
}
const toggleKnobOnStyle: React.CSSProperties = { ...toggleKnobStyle, left: 20 }
const settingRowStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px',
  background: 'var(--dsw-alias-bg-layer-2, #1c1c2e)', borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2, #2e2e4a)', minWidth: 0,
}
const settingTitleStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #e0e0f0)' }
const settingDescStyle: React.CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary, #7c7c9c)' }

/** 无障碍 toggle switch（纯 CSS 滑块，无外部依赖）。 */
function Toggle({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return h('button', {
    type: 'button', role: 'switch', 'aria-checked': checked,
    style: checked ? toggleOnStyle : toggleStyle, title,
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); onChange(!checked) },
  }, h('span', { style: checked ? toggleKnobOnStyle : toggleKnobStyle }))
}

/** 设置行：标题行（右侧滑块）+ 整行说明。 */
function SettingRow({ title, desc, checked, onChange }: {
  title: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return h('div', { style: settingRowStyle },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('div', { style: settingTitleStyle }, title),
      h('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center' } }, h(Toggle, { checked, onChange, title })),
    ),
    h('div', { style: settingDescStyle }, desc),
  )
}
/** 插件确认进度条（一行轻量提示）。 */
const scanProgressStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, fontSize: 11,
  color: 'var(--dsw-alias-label-secondary, #7c7c9c)', margin: '0 0 8px',
}
const scanBarTrackStyle: React.CSSProperties = {
  flex: 1, height: 4, borderRadius: 2, background: 'var(--dsw-alias-bg-layer-2, #2a2a4a)', overflow: 'hidden',
}
const scanBarFillStyle: React.CSSProperties = {
  height: '100%', borderRadius: 2, background: 'var(--dsw-static-deepseek-500, #4176E6)',
  transition: 'width .4s ease',
}
const installedBadgeStyle: React.CSSProperties = {
  marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', flexShrink: 0,
}
const cardFooterStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto',
}
const cardBtnGroupStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto',
}
const cardBtnStyle: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2, #3a3a5a)',
  background: 'var(--dsw-alias-button-elevated-fill, #2a2a4a)',
  color: 'var(--dsw-alias-label-primary, #e0e0f0)', borderRadius: 6,
  padding: '4px 10px', cursor: 'pointer', fontSize: 11,
  transition: 'border-color .15s ease, background-color .15s ease, color .15s ease',
}
const cardBtnPrimaryStyle: React.CSSProperties = {
  ...cardBtnStyle,
  color: 'var(--dsw-static-deepseek-500, #4176E6)',
}
/** Hover micro-interaction for card / scenario / header buttons (CSS class). */
const HOVER_CSS = '.dshd-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08)) !important;border-color:var(--dsw-alias-brand-primary,#7aa2ff) !important}.dshd-update-all:hover{background:#2f5fd0 !important;border-color:#2f5fd0 !important;color:#fff !important}'
/** 轻量 toast（面板内提示，2.2s 自动消失，置顶不挡交互）。 */
const toastStyle: React.CSSProperties = {
  position: 'fixed', left: '50%', bottom: 48, transform: 'translateX(-50%)',
  background: 'rgba(28,28,44,.94)', color: '#e6e6f0', fontSize: 13,
  padding: '8px 18px', borderRadius: 8, zIndex: 1200,
  boxShadow: '0 8px 24px rgba(0,0,0,.35)', whiteSpace: 'nowrap', pointerEvents: 'none',
}
const tabRowStyle: React.CSSProperties = {
  display: 'flex', gap: 4, marginBottom: 12,
}
const tabStyle: React.CSSProperties = {
  border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary, #9aa0b4)',
  fontSize: 13, padding: '8px 16px', cursor: 'pointer', borderRadius: 8,
  transition: 'background-color .15s ease, color .15s ease',
}
const tabOnStyle: React.CSSProperties = {
  ...tabStyle,
  background: 'var(--dsw-static-deepseek-500, #4176E6)',
  color: '#ffffff', fontWeight: 600,
}
const scenarioCardStyle: React.CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1, #1a1a2b)', border: '1px solid var(--dsw-alias-border-l2, #2e2e4a)',
  borderRadius: 12, padding: '16px', display: 'flex', flexDirection: 'column', gap: 10,
}
const scenarioTitleStyle: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #e0e0f0)' }
const scenarioDescStyle: React.CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #9aa0b4)', minHeight: 18 }
const scenarioCountStyle: React.CSSProperties = { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #7c7c9c)' }
const scenarioBtnRowStyle: React.CSSProperties = { display: 'flex', gap: 8, marginTop: 4 }
const repoPanelStyle: React.CSSProperties = {
  position: 'absolute', inset: '28px 32px', maxWidth: 900, margin: '0 auto',
  background: 'var(--dsw-alias-bg-layer-1, #14141f)', border: '1px solid var(--dsw-alias-border-l2, #2e2e4a)',
  borderRadius: 16, boxShadow: '0 24px 64px rgba(0,0,0,.5)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
  zIndex: 1100,
}
const mdBodyStyle: React.CSSProperties = {
  flex: 1, overflowY: 'auto', padding: '16px 20px', font: '13px/1.7 system-ui',
  color: 'var(--dsw-alias-label-secondary, #c6c8d4)',
}
const mdH1Style: React.CSSProperties = { fontSize: 22, fontWeight: 700, margin: '20px 0 10px', color: 'var(--dsw-alias-label-primary, #e0e0f0)', borderBottom: '1px solid var(--dsw-alias-border-l2, #2e2e4a)', paddingBottom: 8 }
const mdH2Style: React.CSSProperties = { fontSize: 18, fontWeight: 600, margin: '18px 0 8px', color: 'var(--dsw-alias-label-primary, #e0e0f0)' }
const mdH3Style: React.CSSProperties = { fontSize: 15, fontWeight: 600, margin: '14px 0 6px', color: 'var(--dsw-alias-label-primary, #e0e0f0)' }
const mdParaStyle: React.CSSProperties = { fontSize: 13, lineHeight: '22px', margin: '8px 0' }
const mdCodeBlockStyle: React.CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2, #1c1c2e)', border: '1px solid var(--dsw-alias-border-l2, #2e2e4a)',
  borderRadius: 8, padding: '12px 14px', margin: '10px 0', overflowX: 'auto',
  font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--dsw-alias-label-primary, #e0e0f0)', whiteSpace: 'pre',
}
const mdInlineCodeStyle: React.CSSProperties = { background: 'var(--dsw-alias-bg-layer-2, #1c1c2e)', borderRadius: 4, padding: '1px 5px', font: '12px ui-monospace, Menlo, monospace', color: 'var(--dsw-alias-brand-primary, #7aa2ff)' }
const mdListItemStyle: React.CSSProperties = { fontSize: 13, lineHeight: '22px', margin: '3px 0', paddingLeft: 4 }
const mdQuoteStyle: React.CSSProperties = { borderLeft: '3px solid var(--dsw-alias-brand-primary, #7aa2ff)', padding: '4px 12px', margin: '10px 0', color: 'var(--dsw-alias-label-tertiary, #9aa0b4)' }
const mdLinkStyle: React.CSSProperties = { color: 'var(--dsw-alias-brand-primary, #7aa2ff)', textDecoration: 'none' }

function StarIcon() {
  return h('svg', { width: 11, height: 11, viewBox: '0 0 14 14', fill: 'currentColor', style: { flexShrink: 0 } },
    h('path', { d: 'M7 0.5L8.9 4.8L13.5 5.3L10.2 8.4L11 13L7 10.7L3 13L3.8 8.4L0.5 5.3L5.1 4.8L7 0.5Z' }),
  )
}

/** 已安装对勾图标（平面 SVG：浅蓝圆底 + 蓝色对勾）。 */
function InstalledIcon() {
  return h('svg', { width: 13, height: 13, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', style: { flexShrink: 0 } },
    h('circle', { cx: 7, cy: 7, r: 6.2, fill: 'var(--dsw-static-deepseek-500, #4176E6)', opacity: 0.16 }),
    h('path', { d: 'M4 7.2L6.2 9.4L10.2 5.2', stroke: 'var(--dsw-static-deepseek-500, #4176E6)', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  )
}

/** 是否已安装：仓库名匹配已安装包名（忽略 npm scope 前缀与大小写）。 */
function isInstalled(plugin: PluginEntry, installed: string[]): boolean {
  const names = new Set(installed.map((n) => (n.split('/').pop() ?? n).toLowerCase()))
  return names.has(plugin.name.toLowerCase())
}

/** ISO 时间 → 本地 HH:mm。 */
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** ISO 时间 → YYYY-MM-DD。 */
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function PluginCard({ plugin, t, installed, scanning, onReview, onViewRepo, onCheckUpdate }: {
  plugin: PluginEntry
  t: Translate
  installed: boolean
  /** 确定性预检进行中（按钮禁用，显示预检中）。 */
  scanning: boolean
  onReview: (plugin: PluginEntry) => void
  onViewRepo: (plugin: PluginEntry) => void
  onCheckUpdate: (plugin: PluginEntry) => void
}) {
  const official = isOfficial(plugin)
  return h('div', { style: cardStyle },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
      h('div', { style: { width: 30, height: 30, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2, #2a2a4a)', display: 'grid', placeItems: 'center', flexShrink: 0 } },
        h(PluginIcon, { size: 14 }),
      ),
      h('div', { style: { minWidth: 0 } },
        h('div', { style: nameStyle }, plugin.name),
        h('div', { style: ownerStyle }, `${plugin.owner} / ${plugin.name}`),
      ),
      installed && h('span', { style: installedBadgeStyle, title: t('installedTooltip') }, h(InstalledIcon)),
    ),
    h('p', { style: descStyle }, plugin.description || '—'),
    h('div', { style: metaStyle },
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 3 } }, h(StarIcon), plugin.stars),
      plugin.language !== null && h('span', null, plugin.language),
      plugin.updatedAt !== '' && h('span', null, `${t('updated')} ${plugin.updatedAt.slice(0, 10)}`),
    ),
    h('div', { style: cardFooterStyle },
      h('span', { style: official ? badgeOfficialStyle : badgeThirdStyle }, official ? t('official') : t('thirdParty')),
      !official && plugin.ownerType === 'user' && h('span', { style: badgePersonalStyle, title: t('personalBadgeTip') }, t('personalBadge')),
      !official && suspiciousStars(plugin) && h('span', { style: badgeStarAnomalyStyle, title: t('starAnomalyTip') }, t('starAnomaly')),
      plugin.isPlugin === 'plugin' && h('span', { style: badgePluginStyle, title: t('pluginBadgeTip') }, t('pluginBadge')),
      plugin.isPlugin === 'not' && h('span', { style: badgeNotPluginStyle, title: t('notPluginBadgeTip') }, t('notPluginBadge')),
      h('div', { style: cardBtnGroupStyle },
        installed
          ? h('button', { type: 'button', className: 'dshd-btn', style: cardBtnPrimaryStyle, title: t('checkUpdate'), onClick: () => onCheckUpdate(plugin) }, t('checkUpdate'))
          : h('button', {
              type: 'button', className: 'dshd-btn', style: cardBtnPrimaryStyle,
              title: t('reviewInstall'), disabled: scanning, onClick: () => onReview(plugin),
            }, scanning ? t('preScanning') : t('reviewInstall')),
        h('button', { type: 'button', className: 'dshd-btn', style: cardBtnStyle, title: t('viewRepo'), onClick: () => onViewRepo(plugin) }, t('viewRepo')),
      ),
    ),
  )
}

/** Resolve the target workspace, open a fresh session, and send one prompt into it. */
async function openSessionAndSend(ctx: DiscoveryClientContext, text: string): Promise<boolean> {
  const ws = ctx.workspaces.list.getSnapshot()
  const current = ctx.sessions.list.getSnapshot().current
  const currentWsId = current === undefined
    ? undefined
    : ws.items.find((item) => item.sessionIds.includes(current))?.workspaceId
  const target = currentWsId ?? ws.recentWorkspaceId
  if (target === undefined) {
    ctx.workspaces.startSession()
    return false
  }
  const sessionId = await ctx.workspaces.connectWorkspace(target)
  ctx.sessions.open(sessionId)
  const scoped = ctx.sessions.scope(sessionId)
  if (scoped === undefined) return false
  const conversation = scoped.get('conversation') as { send(text: string): Promise<void> }
  await conversation.send(text)
  return true
}

/** 确定性预检信号 → 审查 prompt 中的信号清单文本。 */
function signalLines(report: SecurityReport | null): string[] {
  if (report === null) return []
  if (report.signals.length === 0) {
    return ['确定性预检未发现风险信号（无安装脚本、无敏感路径写入、依赖与账号信誉正常）。',
      '但仍需你人工复核代码，确认不存在预检规则覆盖不到的行为。']
  }
  const sev = (s: SecuritySignal): string => s.severity === 'danger' ? '🔴 高危' : s.severity === 'warn' ? '🟡 关注' : '🔵 提示'
  return [
    `确定性预检评级：${report.level === 'caution' ? '🔴 高危（建议默认不安装，除非你确认风险可控）' : report.level === 'review' ? '🟡 需人工审查' : '🟢 无风险信号'}`,
    '',
    '预检发现的信号：',
    ...report.signals.map((s) => `- [${sev(s)}] ${s.title}：${s.detail}`),
  ]
}

function buildReviewPrompt(plugin: PluginEntry, t: Translate, report: SecurityReport | null): string {
  return [
    `请审查并安装插件仓库：${plugin.htmlUrl}（${plugin.owner}/${plugin.name}）`,
    '',
    '该仓库已由 dsh-discovery 完成确定性安全预检（静态规则扫描，仅作锚点，最终判断以你读码为准）。',
    ...signalLines(report),
    '',
    '请按以下清单逐项审查源码（禁止只看 README，README 可伪造）：',
    '1. package.json scripts：是否存在 install/postinstall/prepare 等安装时自动执行的脚本？脚本内容是否涉及下载执行、写敏感路径、窃取密钥？',
    '2. 入口代码（main/bin 指向的文件及 import 链）：是否存在 eval/动态执行、child_process 启动外部命令、写 ~/.ssh 或 shell 配置、读取并外发 .env/API key？',
    '3. 依赖安全：依赖名是否与知名包相似（typosquatting）？依赖数量是否异常？file:/git: 引用的来源是否可信？',
    '4. 网络行为：代码中的外链域名是否都是正常用途（遥测上报 vs 数据窃取）？',
    '5. 与描述相符：功能是否与 README 声明一致，有无隐藏行为？',
    '6. owner 信誉：结合账号年龄与仓库活跃度判断是否为一次性恶意分发账号。',
    '',
    '审查结论：',
    '- 通过 → 使用 dsh plugin add 安装该插件。',
    '- 发现风险 → 列出风险点（含文件位置），明确停止安装。',
    '- 预检评级为 🔴 高危时，除非你阅读代码后确认风险可控，否则默认拒绝安装。',
    '',
    t('networkNote'),
  ].join('\n')
}

function buildCheckUpdatePrompt(plugin: PluginEntry): string {
  return [
    `请检查已安装插件 ${plugin.owner}/${plugin.name} 是否有可用更新：${plugin.htmlUrl}`,
    '',
    '请检查该插件的当前安装版本与最新版本（npm registry 或 GitHub releases）：',
    '1. 对比已安装版本与最新版本',
    '2. 如有更新，简述更新内容（changelog / releases）',
    '3. 更新前必须先审查新版本的安全性（重点对比新旧版本差异，警惕供应链投毒/维护者账号被盗）：',
    '   - 依赖变更：新增了哪些依赖？来源是否可信？有无依赖投毒风险？',
    '   - 代码变更：是否新增网络请求、文件读写、环境变量/密钥访问、命令执行等敏感行为？',
    '   - 权限变化：是否要求额外权限或修改配置？',
    '4. 审查通过后才使用 dsh plugin update 更新；若发现任何风险，列出风险点并停止更新',
  ].join('\n')
}

/**
 * 一键更新 prompt：版本比对已由代码完成（确定性操作），清单是「哪些插件有更新 + 新旧版本」，
 * LLM 只负责对每个候选做安全审查（依赖/代码/权限变更）与安装执行。
 */
function buildBulkUpdatePrompt(updates: InstalledVersion[], t: Translate): string {
  const lines = updates.map((p) => {
    const target = p.source === 'github'
      ? `GitHub 远端最新提交 ${p.remotePushedAt !== null ? formatDate(p.remotePushedAt) : '?'}`
      : `npm 最新版 ${p.latest ?? '?'}`
    return `- ${p.name}：当前 ${p.current} → ${target}`
  })
  return [
    '以下已安装插件有可用更新（版本比对已由插件搜索插件代码完成：npm registry 最新版 + GitHub 远端 commit 基线）：',
    '',
    ...lines,
    '',
    '请逐个更新，但更新前必须先安全审查每个插件的新版本（重点对比新旧版本差异，警惕供应链投毒/维护者账号被盗）：',
    '1. 依赖变更：新增了哪些依赖？来源是否可信？有无投毒风险？',
    '2. 代码变更：是否新增网络请求、文件读写、环境变量/密钥访问、命令执行等敏感行为？',
    '3. 权限变化：是否要求额外权限或修改配置？',
    '',
    '审查通过后才使用 dsh plugin update 更新该插件；若发现任何风险，列出风险点并停止更新该插件。',
    '完成后简述：更新了哪些、跳过了哪些及原因。',
    '',
    t('networkNote'),
  ].join('\n')
}

function scenarioLines(plugins: PluginEntry[]): string[] {
  return plugins.slice(0, 20).map((p) => {
    const signals = [
      p.ownerType === 'user' ? '个人账号' : null,
      suspiciousStars(p) ? '星数/fork 异常' : null,
    ].filter((s) => s !== null)
    const sig = signals.length > 0 ? `（信号：${signals.join('、')}）` : ''
    return `- ${p.owner}/${p.name}${sig}（⭐${p.stars}，更新于 ${p.updatedAt.slice(0, 10)}）：${p.description || '—'}`
  })
}

function buildScenarioBatchPrompt(scenario: Scenario, plugins: PluginEntry[], t: Translate): string {
  return [
    `请为「${t(`scenario_${scenario.id}`)}」场景安装匹配插件。`,
    '',
    `场景需求：${t(`scenario_${scenario.id}_desc`)}`,
    '',
    '候选插件清单（已按 star 数排序，含信誉信号标注）：',
    ...scenarioLines(plugins),
    '',
    '请自主判断并安装：',
    '1. 不要安装功能重复的插件（同类功能只选最优，以 star 数和更新时间为准）',
    '2. 安全硬门槛——以下高风险特征任一命中，直接跳过该插件并在报告中注明原因（不安装）：',
    '   - owner 为全新账号（注册不足 90 天）或「个人账号 + 新仓库 + 高 star」组合',
    '   - package.json 含 install/postinstall/prepare 安装脚本，且脚本内容涉及下载执行、写敏感路径、读密钥',
    '   - 入口代码存在 base64 解码后执行、写 ~/.ssh 或 shell 配置、把密钥外发到陌生域名',
    '   - 依赖名与 @deepseek-ai/* 等核心包相似（typosquatting 嫌疑）',
    '   - 星数/fork 比异常（高 star 低 fork，疑似刷星）',
    '3. 通过安全门槛的候选，仍需快速核对源码后使用 dsh plugin add 安装',
    '4. 完成后简述：安装了哪些、跳过了哪些及原因（被跳过的必须说明命中哪条安全门槛）',
    '',
    t('networkNote'),
  ].join('\n')
}

function buildScenarioCustomPrompt(scenario: Scenario, plugins: PluginEntry[], t: Translate): string {
  return [
    `请为「${t(`scenario_${scenario.id}`)}」场景评估插件。`,
    '',
    `场景需求：${t(`scenario_${scenario.id}_desc`)}`,
    '',
    '候选插件清单（已按 star 数排序）：',
    ...scenarioLines(plugins),
    '',
    '请评估后给出推荐列表和推荐理由（先不要安装）：',
    '1. 推荐安装哪些插件、各自理由',
    '2. 不推荐哪些、原因（功能重复 / 质量 / 安全）',
    '3. 等我确认后再安装',
    '',
    t('networkNote'),
  ].join('\n')
}

/* ── lightweight markdown renderer (zero-dependency) ─────────────────────── */

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let key = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(h('code', { key: key++, style: mdInlineCodeStyle }, token.slice(1, -1)))
    } else if (token.startsWith('**')) {
      nodes.push(h('strong', { key: key++ }, token.slice(2, -2)))
    } else if (token.startsWith('*')) {
      nodes.push(h('em', { key: key++ }, token.slice(1, -1)))
    } else {
      const link = token.match(/\[([^\]]+)\]\(([^)]+)\)/)
      if (link) nodes.push(h('a', { key: key++, href: link[2], target: '_blank', rel: 'noreferrer', style: mdLinkStyle }, link[1]))
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function renderMarkdown(md: string): ReactNode[] {
  const lines = md.split('\n')
  const nodes: ReactNode[] = []
  let key = 0
  let inCode = false
  let codeLines: string[] = []
  let i = 0

  const flushCode = (): void => {
    if (codeLines.length > 0) {
      nodes.push(h('pre', { key: key++, style: mdCodeBlockStyle }, h('code', null, codeLines.join('\n'))))
      codeLines = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]
    if (line.trimStart().startsWith('```')) {
      if (inCode) { flushCode(); inCode = false } else { inCode = true }
      i++
      continue
    }
    if (inCode) { codeLines.push(line); i++; continue }
    if (line.trim() === '') { i++; continue }

    const hMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (hMatch) {
      const level = hMatch[1].length
      const style = level <= 1 ? mdH1Style : level === 2 ? mdH2Style : mdH3Style
      const tag = level <= 1 ? 'h1' : level === 2 ? 'h2' : 'h3'
      nodes.push(h(tag, { key: key++, style }, renderInline(hMatch[2])))
      i++
      continue
    }

    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ulMatch) {
      nodes.push(h('div', { key: key++, style: mdListItemStyle },
        h('span', { style: { color: 'var(--dsw-alias-brand-primary, #7aa2ff)' } }, '• '), renderInline(ulMatch[1])))
      i++
      continue
    }

    const olMatch = line.match(/^\s*(\d+)\.\s+(.*)$/)
    if (olMatch) {
      nodes.push(h('div', { key: key++, style: mdListItemStyle },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary, #7c7c9c)' } }, `${olMatch[1]}. `), renderInline(olMatch[2])))
      i++
      continue
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/)
    if (quoteMatch) {
      nodes.push(h('blockquote', { key: key++, style: mdQuoteStyle }, renderInline(quoteMatch[1])))
      i++
      continue
    }

    nodes.push(h('p', { key: key++, style: mdParaStyle }, renderInline(line)))
    i++
  }
  if (inCode) flushCode()
  return nodes
}

function RepoPreview({ plugin, t, onClose }: { plugin: PluginEntry; t: Translate; onClose: () => void }) {
  const [state, setState] = useState<'loading' | 'error' | 'done'>('loading')
  const [readme, setReadme] = useState('')

  useEffect(() => {
    setState('loading')
    setReadme('')
    const url = `/dsh-discovery/readme?owner=${encodeURIComponent(plugin.owner)}&repo=${encodeURIComponent(plugin.name)}`
    fetch(url, { cache: 'no-store' })
      .then((res) => { if (!res.ok) throw new Error('HTTP ' + String(res.status)); return res.json() })
      .then((body: { markdown: string }) => { setReadme(body.markdown); setState('done') })
      .catch(() => setState('error'))
  }, [plugin.owner, plugin.name])

  return h('div', { style: maskStyle, onClick: onClose },
    h('div', { style: repoPanelStyle, onClick: (e: React.MouseEvent) => e.stopPropagation() },
      h('div', { style: headerStyle },
        h(PluginIcon, { size: 15 }),
        h('span', { style: { flex: 1 } }, `${plugin.owner}/${plugin.name}`),
        h('a', { href: plugin.htmlUrl, target: '_blank', rel: 'noreferrer', className: 'dshd-btn', style: repoBtnStyle, title: t('openOnGitHub') }, t('openOnGitHub')),
        h('button', { className: 'dshd-btn', style: closeStyle, onClick: onClose, 'aria-label': '关闭', title: '关闭' }, '✕'),
      ),
      state === 'loading' && h('div', { style: loadingStyle }, t('readmeLoading')),
      state === 'error' && h('div', { style: emptyStyle }, t('readmeFail')),
      state === 'done' && (readme === '' ? h('div', { style: emptyStyle }, t('noReadme')) : h('div', { style: mdBodyStyle }, renderMarkdown(readme))),
    ),
  )
}

function ScenarioPanel({ listing, t, onInstall, onCustom }: {
  listing: PluginListing | null
  t: Translate
  onInstall: (scenario: Scenario, plugins: PluginEntry[]) => void
  onCustom: (scenario: Scenario, plugins: PluginEntry[]) => void
}) {
  return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 } },
    h('p', { style: disclaimerStyle }, `⚠️ ${t('disclaimerBody')}`),
    h('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #e0e0f0)', margin: '0 0 12px' } }, t('scenariosTitle')),
    h('div', { style: { ...bodyStyle, flex: 1 } },
      h('div', { style: gridStyle },
        SCENARIOS.map((scenario) => {
          const matched = scenarioPlugins(listing, scenario)
          return h('div', { key: scenario.id, style: scenarioCardStyle },
            h('div', { style: scenarioTitleStyle }, t(`scenario_${scenario.id}`)),
            h('div', { style: scenarioDescStyle }, t(`scenario_${scenario.id}_desc`)),
            h('div', { style: scenarioCountStyle }, t('scenarioMatchCount').replace('{n}', String(matched.length))),
            h('div', { style: scenarioBtnRowStyle },
              h('button', { type: 'button', className: 'dshd-btn', style: cardBtnPrimaryStyle, title: t('installAll'), onClick: () => onInstall(scenario, matched) }, t('installAll')),
              h('button', { type: 'button', className: 'dshd-btn', style: cardBtnStyle, title: t('customInstall'), onClick: () => onCustom(scenario, matched) }, t('customInstall')),
            ),
          )
        }),
      ),
    ),
  )
}

function DiscoveryBrowser({ t, ctx, onClose, onFetched }: {
  t: Translate
  ctx: DiscoveryClientContext
  onClose: () => void
  onFetched: (at: string) => void
}) {
  const [tab, setTab] = useState<'browse' | 'scenario' | 'installed'>('browse')
  const [listing, setListing] = useState<PluginListing | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [installed, setInstalled] = useState<string[]>([])
  const [installedVersions, setInstalledVersions] = useState<InstalledVersion[] | null>(null)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [preview, setPreview] = useState<PluginEntry | null>(null)
  /** 确定性预检进行中的插件（按钮禁用防重复点击）。 */
  const [scanning, setScanning] = useState<PluginEntry | null>(null)
  /** 插件判定结果：key = `${owner}/${repo}`。'unknown'=网络失败（视同未判定）。 */
  const [pluginStatus, setPluginStatus] = useState<Record<string, 'plugin' | 'not' | 'unknown'>>({})
  /** 后台渐进判定进度。 */
  const [scanProgress, setScanProgress] = useState<{ running: boolean; scanned: number; total: number; cached: boolean }>({ running: false, scanned: 0, total: 0, cached: false })
  /** 「只看插件」开关（localStorage 持久化视图偏好）。 */
  const [onlyPlugins, setOnlyPlugins] = useState<boolean>(() => {
    try { return localStorage.getItem(ONLY_PLUGINS_KEY) === '1' } catch { return false }
  })
  const handleOnlyPlugins = (v: boolean): void => {
    setOnlyPlugins(v)
    try { localStorage.setItem(ONLY_PLUGINS_KEY, v ? '1' : '0') } catch { /* 隐私模式等不可用时忽略 */ }
  }
  /** AI 生态摘要开关（host 持久化，默认开）。 */
  const [aiSummary, setAiSummary] = useState(true)
  /** GitHub 全文搜索兜底：本地过滤无结果时触发。null=未搜索；[]=已搜无结果。 */
  const [searchResults, setSearchResults] = useState<PluginEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  // 轻量 toast（无更新提示等）
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const showToast = (text: string): void => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2200)
  }

  const load = (): void => {
    setLoadError(false)
    // sessionStorage 缓存：TTL 内直接使用，避免每次打开面板都重新拉取 GitHub
    const cached = readListingCache()
    if (cached !== null) {
      setListing(cached)
      onFetched(cached.fetchedAt)
      return
    }
    fetch('/dsh-discovery/listing', { cache: 'no-store' })
      .then((res) => { if (!res.ok) throw new Error('HTTP ' + String(res.status)); return res.json() })
      .then((body: PluginListing) => {
        writeListingCache(body)
        setListing(body)
        onFetched(body.fetchedAt)
      })
      .catch(() => setLoadError(true))
  }
  /** 强制刷新：清 sessionStorage 缓存 + host force 重拉 GitHub（空列表/加载失败时的手动恢复通道）。 */
  const handleForceRefresh = (): void => {
    sessionStorage.removeItem(LISTING_CACHE_KEY)
    setLoadError(false)
    fetch('/dsh-discovery/listing?force=1', { cache: 'no-store' })
      .then((res) => { if (!res.ok) throw new Error('HTTP ' + String(res.status)); return res.json() })
      .then((body: PluginListing) => {
        writeListingCache(body)
        setListing(body)
        onFetched(body.fetchedAt)
      })
      .catch(() => setLoadError(true))
  }
  useEffect(load, [])
  useEffect(() => {
    fetch('/dsh-discovery/installed', { cache: 'no-store' })
      .then((res) => { if (!res.ok) return []; return res.json() })
      .then((body: { installed: string[] }) => setInstalled(body.installed ?? []))
      .catch(() => setInstalled([]))
  }, [])
  // 已安装插件版本比对（代码侧：读当前版本 + 查 npm 最新版）
  useEffect(() => {
    fetch('/dsh-discovery/installed-versions', { cache: 'no-store' })
      .then((res) => { if (!res.ok) throw new Error('HTTP ' + String(res.status)); return res.json() })
      .then((body: { plugins: InstalledVersion[] }) => setInstalledVersions(body.plugins ?? []))
      .catch(() => setInstalledVersions([]))
  }, [])
  // 后台插件判定：拉状态 → 合并结果 + 更新进度；扫描未完成则每 2s 轮询
  useEffect(() => {
    let timer: number | undefined = undefined
    let stopped = false
    const poll = (): void => {
      fetch('/dsh-discovery/plugin-status', { cache: 'no-store' })
        .then((res) => { if (!res.ok) throw new Error('HTTP ' + String(res.status)); return res.json() })
        .then((body: PluginScanState) => {
          if (stopped) return
          setPluginStatus(body.statuses ?? {})
          setScanProgress({ running: body.running, scanned: body.scanned, total: body.total, cached: body.cached })
          if (body.running) {
            timer = window.setTimeout(poll, 2000)
          } else if (timer === undefined && body.scanned === 0 && body.total > 0) {
            // 扫描刚启动首轮：继续轮询直到 running=false
            timer = window.setTimeout(poll, 2000)
          }
        })
        .catch(() => {
          if (stopped) return
          // 网络/服务异常：10s 后重试，不阻塞列表
          timer = window.setTimeout(poll, 10000)
        })
    }
    poll()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [])
  // AI 生态摘要开关：读 host 设置（默认开）
  useEffect(() => {
    fetch('/dsh-discovery/settings', { cache: 'no-store' })
      .then((res) => { if (!res.ok) return null; return res.json() })
      .then((body: { aiSummaryEnabled?: boolean } | null) => {
        if (body !== null && typeof body.aiSummaryEnabled === 'boolean') setAiSummary(body.aiSummaryEnabled)
      })
      .catch(() => { /* 读设置失败保持默认开 */ })
  }, [])
  const handleAiSummaryToggle = (v: boolean): void => {
    setAiSummary(v)
    void fetch('/dsh-discovery/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aiSummaryEnabled: v }),
      cache: 'no-store',
    }).catch(() => { /* 写失败：UI 状态已更新，下次打开读盘回退 */ })
  }

  const cats = useMemo(() => orderedCategories(listing), [listing])
  // 过滤（q + cat）后合并后台插件判定结果：isPlugin 从 pluginStatus 取，未判定/unknown 为 null
  const plugins = useMemo(() => {
    return filterPlugins(listing, { q, cat }).map((p) => {
      const kind = pluginStatus[`${p.owner}/${p.name}`]
      return { ...p, isPlugin: kind === 'plugin' || kind === 'not' ? kind : null }
    })
  }, [listing, q, cat, pluginStatus])
  // 「只看插件」视图：主区只放已确认插件，未判定沉底待确认区（不占排序位）
  const mainPlugins = onlyPlugins ? plugins.filter((p) => p.isPlugin === 'plugin') : plugins
  const pendingPlugins = onlyPlugins ? plugins.filter((p) => p.isPlugin === null) : []

  // GitHub 全文搜索兜底：本地 topic 列表过滤无结果时，防抖触发在线搜索
  // （GitHub topic 索引对新仓库有延迟，搜名字也搜不到，需走全文搜索）。
  const searchTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    const term = q.trim()
    if (term === '' || plugins.length > 0) {
      window.clearTimeout(searchTimer.current)
      setSearchResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(() => {
      fetch(`/dsh-discovery/search?q=${encodeURIComponent(term)}`, { cache: 'no-store' })
        .then((res) => { if (!res.ok) throw new Error('HTTP ' + String(res.status)); return res.json() })
        .then((body: { plugins: PluginEntry[] }) => setSearchResults(body.plugins ?? []))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false))
    }, 400)
    return () => window.clearTimeout(searchTimer.current)
    // plugins.length 而非 plugins：避免每次过滤重算（新数组引用）都触发
  }, [q, cat, plugins.length])

  // 本地无结果时的兜底视图（定义在 handler 之后，见下方 fallbackView）

  /**
   * 审查安装：先调 host 确定性预检（拉 package.json + 静态规则扫描，~1-2s），
   * 预检报告随 prompt 一起发进会话，作为 LLM 深度审查的锚点。
   * 预检失败（网络/非 npm 仓库）降级为无报告 prompt。
   */
  const handleReview = (plugin: PluginEntry): void => {
    setScanning(plugin)
    void fetch(`/dsh-discovery/security?owner=${encodeURIComponent(plugin.owner)}&repo=${encodeURIComponent(plugin.name)}`, { cache: 'no-store' })
      .then((res) => { if (!res.ok) throw new Error('HTTP ' + String(res.status)); return res.json() })
      .then((report: SecurityReport) => {
        onClose()
        void openSessionAndSend(ctx, buildReviewPrompt(plugin, t, report))
      })
      .catch(() => {
        onClose()
        void openSessionAndSend(ctx, buildReviewPrompt(plugin, t, null))
      })
      .finally(() => setScanning(null))
  }
  const handleCheckUpdate = (plugin: PluginEntry): void => {
    onClose()
    void openSessionAndSend(ctx, buildCheckUpdatePrompt(plugin))
  }
  const handleInstall = (scenario: Scenario, matched: PluginEntry[]): void => {
    onClose()
    void openSessionAndSend(ctx, buildScenarioBatchPrompt(scenario, matched, t))
  }
  const handleCustom = (scenario: Scenario, matched: PluginEntry[]): void => {
    onClose()
    void openSessionAndSend(ctx, buildScenarioCustomPrompt(scenario, matched, t))
  }
  const handleUpdateAll = (): void => {
    const updates = (installedVersions ?? []).filter((p) => p.hasUpdate)
    if (updates.length === 0) {
      showToast(t('updateEmpty'))
      return
    }
    onClose()
    void openSessionAndSend(ctx, buildBulkUpdatePrompt(updates, t))
  }

  // 本地无结果时的兜底视图：在线搜索中 / 搜索结果 / 确认无结果
  // ⚠️ 必须定义在 handler 之后：引用了 handleReview，提前定义触发 TDZ（ReferenceError）
  const fallbackView: ReactNode = plugins.length === 0 && q.trim() !== ''
    ? (searching
        ? h('div', { style: loadingStyle }, t('searchingOnline'))
        : (searchResults !== null && searchResults.length > 0
            ? h('div', { style: { width: '100%' } },
                h('div', { style: onlineNoteStyle }, t('searchOnlineResults').replace('{n}', String(searchResults.length))),
                h('div', { style: gridStyle },
                  searchResults.map((p) => h(PluginCard, {
                    key: p.htmlUrl,
                    plugin: { ...p, isPlugin: pluginStatus[`${p.owner}/${p.name}`] === 'plugin' || pluginStatus[`${p.owner}/${p.name}`] === 'not' ? pluginStatus[`${p.owner}/${p.name}`] : null },
                    t, installed: isInstalled(p, installed), scanning: scanning !== null && scanning.htmlUrl === p.htmlUrl,
                    onReview: handleReview, onViewRepo: (x) => setPreview(x), onCheckUpdate: handleCheckUpdate,
                  })),
                ),
              )
            : h('div', { style: emptyStyle }, t('empty'))))
    : null

  return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 } },
    h('div', { style: tabRowStyle },
      h('button', { type: 'button', style: tab === 'browse' ? tabOnStyle : tabStyle, onClick: () => setTab('browse') }, t('all')),
      h('button', { type: 'button', style: tab === 'scenario' ? tabOnStyle : tabStyle, onClick: () => setTab('scenario') }, t('scenariosTab')),
      h('button', { type: 'button', style: tab === 'installed' ? tabOnStyle : tabStyle, onClick: () => setTab('installed') }, t('installedTab')),
    ),
    tab === 'browse' && h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 } },
      h('p', { style: disclaimerStyle }, `⚠️ ${t('disclaimerBody')}`),
      h('input', {
        style: searchStyle,
        placeholder: t('searchPh'),
        value: q,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value),
      }),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8, marginBottom: 10 } },
        h(SettingRow, {
          title: t('onlyPlugins'),
          desc: t('onlyPluginsDesc'),
          checked: onlyPlugins,
          onChange: handleOnlyPlugins,
        }),
        h(SettingRow, {
          title: t('aiSummaryToggle'),
          desc: t('aiSummaryDesc'),
          checked: aiSummary,
          onChange: handleAiSummaryToggle,
        }),
      ),
      (scanProgress.running || scanProgress.total > 0) && h('div', { style: scanProgressStyle },
        h('div', { style: scanBarTrackStyle },
          h('div', {
            style: {
              ...scanBarFillStyle,
              width: scanProgress.total > 0 ? `${Math.round((scanProgress.scanned / scanProgress.total) * 100)}%` : '0%',
            },
          }),
        ),
        h('span', { style: { whiteSpace: 'nowrap' } },
          scanProgress.running
            ? t('pluginScanProgress').replace('{n}', String(scanProgress.scanned)).replace('{total}', String(scanProgress.total))
            : scanProgress.cached ? t('pluginScanCached') : t('pluginScanDone'),
        ),
      ),
      h('div', { style: catRowStyle },
        h('button', { style: cat === 'all' ? catOnStyle : catStyle, onClick: () => setCat('all') }, t('all')),
        cats.map((c) => h('button', {
          key: c.id,
          style: cat === c.id ? catOnStyle : catStyle,
          onClick: () => setCat(c.id),
        }, `${t('category_' + c.id)} (${c.count})`)),
      ),
      h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #7c7c9c)', marginBottom: 10 } },
        t('total').replace('{n}', String(listing?.total ?? 0)) + ' · ' + t('fetchedFrom'),
      ),
      h('div', { style: bodyStyle, flex: 1 },
        loadError && h('div', { style: emptyStyle }, t('loadFail') + ' — ' + t('refresh')),
        !loadError && listing === null && h('div', { style: loadingStyle }, t('loading')),
        !loadError && listing !== null && mainPlugins.length > 0 && h('div', { style: gridStyle },
          mainPlugins.map((p) => h(PluginCard, {
            key: p.htmlUrl, plugin: p, t, installed: isInstalled(p, installed), scanning: scanning !== null && scanning.htmlUrl === p.htmlUrl,
            onReview: handleReview, onViewRepo: (x) => setPreview(x), onCheckUpdate: handleCheckUpdate,
          })),
        ),
        !loadError && listing !== null && onlyPlugins && pendingPlugins.length > 0 && h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #7c7c9c)', padding: '12px 0', borderTop: '1px dashed var(--dsw-alias-border-l2, #2e2e4a)' } },
          t('pendingVerify').replace('{n}', String(pendingPlugins.length)),
        ),
        !loadError && listing !== null && onlyPlugins && mainPlugins.length === 0 && pendingPlugins.length === 0 && plugins.length > 0 && h('div', { style: emptyStyle }, t('noPluginFiltered')),
        !loadError && listing !== null && fallbackView,
        !loadError && listing !== null && plugins.length === 0 && q.trim() === '' && h('div', { style: emptyStyle },
          h('div', null, t('empty')),
          h('button', {
            type: 'button', className: 'dshd-btn', style: { ...cardBtnStyle, marginTop: 10 },
            onClick: handleForceRefresh,
          }, t('refresh')),
        ),
      ),
    ),
    tab === 'scenario' && h(ScenarioPanel, { listing, t, onInstall: handleInstall, onCustom: handleCustom }),
    tab === 'installed' && h(InstalledPanel, { t, versions: installedVersions, onUpdateAll: handleUpdateAll, onViewRepo: (v) => setPreview(toPluginEntry(v)), onCheckUpdate: (v) => handleCheckUpdate(toPluginEntry(v)) }),
    preview !== null && h(RepoPreview, { plugin: preview, t, onClose: () => setPreview(null) }),
    toast !== null && h('div', { style: toastStyle }, toast),
  )
}

/** InstalledVersion → PluginEntry（仓库预览面板复用；仅 owner/name/htmlUrl 有效）。 */
function toPluginEntry(v: InstalledVersion): PluginEntry {
  const parts = (v.repo ?? `${v.name}/${v.name}`).split('/')
  return {
    name: parts[1] ?? v.name,
    owner: parts[0] ?? '',
    description: '',
    stars: 0,
    language: null,
    updatedAt: v.remotePushedAt ?? '',
    htmlUrl: v.repo !== null ? `https://github.com/${v.repo}` : '',
    topics: [],
    ownerType: null,
    repoCreatedAt: '',
    forks: 0,
    isPlugin: null,
  }
}

/** 已安装 tab：顶部紧凑一键更新 + 卡片式插件列表（npm + GitHub 多源比对结果）。 */
function InstalledPanel({ t, versions, onUpdateAll, onViewRepo, onCheckUpdate }: {
  t: Translate
  versions: InstalledVersion[] | null
  onUpdateAll: () => void
  onViewRepo: (version: InstalledVersion) => void
  onCheckUpdate: (version: InstalledVersion) => void
}) {
  const updatable = (versions ?? []).filter((p) => p.hasUpdate)

  const badgeOf = (p: InstalledVersion): { text: string; style: React.CSSProperties } => {
    const base: React.CSSProperties = { fontSize: 11, padding: '2px 8px', borderRadius: 10, whiteSpace: 'nowrap', flexShrink: 0 }
    if (p.hasUpdate) {
      const src = p.source === 'npm' ? t('fromNpm') : p.source === 'github' ? t('fromGithub') : ''
      return {
        text: src === '' ? t('updateAvailable') : `${t('updateAvailable')} · ${src}`,
        style: { ...base, background: '#fff4e5', color: '#b45309' },
      }
    }
    if (p.latest !== null || p.baselineSha !== null) {
      return { text: t('upToDate'), style: { ...base, background: '#e8f7ee', color: '#1a7f37' } }
    }
    if (p.repo !== null) {
      return { text: t('baselineReady'), style: { ...base, background: '#e8f0fe', color: '#1a56db' } }
    }
    return { text: t('versionUnknown'), style: { ...base, background: '#f3f4f6', color: '#6b7280' } }
  }

  const versionLine = (p: InstalledVersion): string => {
    if (p.latest !== null) return `${t('currentVersion')} v${p.current} → ${t('latestVersion')} v${p.latest}`
    return `${t('currentVersion')} v${p.current}`
  }

  const metaLine = (p: InstalledVersion): string => {
    const parts: string[] = []
    if (p.latestPublishedAt !== null) parts.push(`${t('fromNpm')} ${formatDate(p.latestPublishedAt)}`)
    if (p.repo !== null && p.remotePushedAt !== null) {
      parts.push(p.baselineSha !== null
        ? `${t('repoLatest')} ${formatDate(p.remotePushedAt)}`
        : `${t('baselineReady')} · ${formatDate(p.remotePushedAt)}`)
    }
    return parts.length > 0 ? parts.join(' · ') : '—'
  }

  return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 } },
    h('div', { style: { padding: '12px 14px', borderBottom: '1px solid var(--dsw-alias-divider, #ececf2)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
      h('button', {
        type: 'button', className: 'dshd-btn dshd-update-all',
        style: {
          ...cardBtnPrimaryStyle,
          background: '#4176e6', borderColor: '#4176e6', color: '#fff',
          padding: '6px 14px', fontSize: 12, fontWeight: 600,
        },
        title: updatable.length > 0 ? `${t('updateAll')} (${updatable.length})` : t('updateEmpty'),
        onClick: onUpdateAll,
      }, `${t('updateAll')}${updatable.length > 0 ? ` (${updatable.length})` : ''}`),
      h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #7c7c9c)' } }, t('updateAllNote')),
    ),
    h('div', { style: { flex: 1, overflowY: 'auto', padding: 12 } },
      versions === null && h('div', { style: loadingStyle }, t('updateLoading')),
      versions !== null && versions.length === 0 && h('div', { style: emptyStyle }, t('noInstalled')),
      versions !== null && versions.length > 0 && h('div', { style: gridStyle },
        versions.map((p) => h('div', { key: p.name, style: cardStyle },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
            h('div', { style: { width: 30, height: 30, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2, #2a2a4a)', display: 'grid', placeItems: 'center', flexShrink: 0 } },
              h(PluginIcon, { size: 14 }),
            ),
            h('div', { style: { minWidth: 0 } },
              h('div', { style: nameStyle }, p.name),
              p.repo !== null && h('div', { style: ownerStyle }, p.repo),
            ),
            h('span', { style: badgeOf(p).style }, badgeOf(p).text),
          ),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-primary, #e0e0f0)' } }, versionLine(p)),
          h('div', { style: metaStyle }, metaLine(p)),
          h('div', { style: cardFooterStyle },
            h('div', { style: cardBtnGroupStyle },
              p.hasUpdate && h('button', { type: 'button', className: 'dshd-btn', style: cardBtnPrimaryStyle, title: t('checkUpdate'), onClick: () => onCheckUpdate(p) }, t('checkUpdate')),
              p.repo !== null && h('button', { type: 'button', className: 'dshd-btn', style: repoBtnStyle, title: t('viewRepo'), onClick: () => onViewRepo(p) }, t('viewRepo')),
            ),
          ),
        )),
      ),
    ),
  )
}

export function apply(ctx: DiscoveryClientContext): void {
  const NS = 'dsh-discovery'
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-discovery: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('sidebar.primary.action', () => ctx.slots.register({
    name: 'sidebar.primary.action',
    id: 'dsh-discovery',
    order: 1,
    locale: NS,
  }, (owner: { wide: boolean }) => h(DiscoveryTrigger, { wide: owner.wide ?? false, t, ctx })))
}

function DiscoveryTrigger({ wide, t, ctx }: { wide: boolean; t: Translate; ctx: DiscoveryClientContext }) {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [fetchedAt, setFetchedAt] = useState('')
  const close = (): void => setOpen(false)
  const closeButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])
  useEffect(() => { if (open) closeButton.current?.focus() }, [open])

  const style = wide ? { ...btnStyle, ...(hovered ? btnHoverStyle : null) } : railStyle

  return h('div', { style: { display: 'contents' } },
    h('style', null, HOVER_CSS),
    h('button', {
      type: 'button',
      style,
      title: t('nav'),
      'aria-label': t('nav'),
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onClick: () => setOpen(true),
    },
      h(PluginIcon, { size: wide ? 15 : 18 }),
      wide && h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('nav')),
    ),
    open && h('div', { style: maskStyle, onClick: close },
      h('div', { style: panelStyle, onClick: (e: React.MouseEvent) => e.stopPropagation() },
        h('div', { style: headerStyle },
          h(PluginIcon, { size: 15 }),
          h('span', null, t('nav')),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #7c7c9c)', fontWeight: 400 } }, t('subtitle')),
          fetchedAt !== '' && h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9aa0b4)', fontWeight: 400 } }, `${t('lastRefresh')} ${formatTime(fetchedAt)}`),
          h('button', { ref: closeButton, style: closeStyle, onClick: close, 'aria-label': '关闭', title: '关闭' }, '✕'),
        ),
        h('div', { style: { flex: 1, overflowY: 'hidden', padding: '0 4px' } }, h(DiscoveryBrowser, { t, ctx, onClose: close, onFetched: setFetchedAt })),
      ),
    ),
  )
}

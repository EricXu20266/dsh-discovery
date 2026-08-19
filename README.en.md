# dsh-discovery

> 🌐 **English | [中文](README.md)**

DSH community plugin discovery browser — a read-only tool for browsing and searching DeepSeek Harness community plugins.

> **Core positioning: two-layer defense — deterministic pre-scan + LLM-audited install.** DHS currently has no official plugin marketplace, and any third-party plugin is essentially "executable code". This tool is therefore deliberately **read-only**, with a two-layer security model: the **code layer** runs static-rule deterministic pre-scans (collecting factual signals, never passing judgment), and the **model layer** lets the LLM (DHS's agent) do a deep audit anchored on that report (reading source, inspecting dependencies, identifying malicious patterns) before installing.

---

## Why "deterministic pre-scan + LLM audit"

Plugins are code injected directly into the DHS host process. Once installed, they have the same local privileges as you (reading files, running commands, accessing the network). Without an official marketplace providing code audit and signing endorsement, trust in third-party plugins can only come from "checking before installing".

As malicious plugins (supply-chain poisoning, compromised-maintainer poisoning, star-farming disguises) become more common, **relying on the LLM to review from scratch every time leaks** — the LLM may only skim the README (which can be forged) and has no explicit anchors. So the review is split into two layers:

| Layer | Who | What | Why |
|---|---|---|---|
| **L0 metadata signals** | Code | List page shows owner type / account & repo age / star-fork ratio directly | Zero extra requests (fields already in the GitHub search API) |
| **L1 deterministic pre-scan** | Code | Static rules over the repo: install scripts, dangerous entry-code patterns, dependency poisoning, owner reputation | Deterministic, cacheable, fast — **marks, never condemns** |
| **L2 LLM deep audit** | LLM | Re-checks each item from the L1 report by reading code; final verdict | Understands semantics, sees context, decides |

> **Signal philosophy**: when static rules flag a pattern they only **mark it, not sentence it** — the evidence (script content, code snippet, file location) is handed to the LLM verbatim for confirmation. A false positive costs the reviewer one extra look; a missed supply-chain attack costs the machine. Factual signals (script exists, account age, suspiciously similar dependency names) have zero false positives.

dsh-discovery itself maintains a strict read-only boundary: it never installs, updates, uninstalls, or loads any remote code — all interactions with repositories are limited to fetching listings, README/package.json text, and opening external links. **Review and installation are entirely performed by the LLM within the session**, and the user always sees the LLM's review process and conclusion.

### Audit flow

```
Discover → Filter → One-click submit → Deterministic pre-scan → LLM deep audit → Pass / Reject
 │          │          │                     │                   │          ├─ Pass: LLM runs dsh plugin add to install
 │          │          │                     │                   └──────────└─ Risk: LLM lists risk points and stops
 │          │          │                     └──── host static scan (~1-2s), report sent with the audit prompt
 │          │          └──────────────  generates audit prompt, sends into current session
 │          └──────────────────  categorize / search / scenario filter
 └──────────────────────────────  browse GitHub `dsh-plugin` community topic
```

1. **Browse/Search**: browse community plugins by category, keyword, or scenario (read-only; never loads remote code)
2. **One-click submit**: click "Audit & Install" → the host runs a deterministic pre-scan first (button shows "Pre-scanning…", ~1-2s) → the pre-scan report is sent into the session together with the audit prompt
3. **LLM deep audit** (mandated by the prompt, and **forbidden to rely on the README alone**):
   - Carries the L1 signal list and evidence snippets, re-verifying each item
   - **Install scripts**: `install/postinstall/prepare` present? Download-and-execute, sensitive-path writes, secret theft?
   - **Entry code**: `eval`/dynamic execution, `child_process`, writes to `~/.ssh` or shell config, reading & exfiltrating `.env`/API keys?
   - **Dependency safety**: typosquatting (names similar to core packages), abnormal counts, untrusted `file:`/`git:` refs
   - **Network behavior**: purpose of external domains (telemetry vs data exfiltration)
   - **Conformance**: matches the README claims, no hidden behavior
   - **Owner reputation**: account age and repo activity
4. **Execute or reject**: passed → the LLM installs with `dsh plugin add`; **high-risk (🔴) pre-scan defaults to reject** unless the LLM confirms after reading the code; risk found → the LLM lists risk points and **stops**
5. **Scenario batch follows the same path**: the LLM first checks reputation signals, **skips candidates hitting the hard security gate** (brand-new account / install script download-execute / sensitive-path writes / typosquatting / star-farming), then audits, dedupes, and installs the rest

---

## Features

- **Community plugin browsing**: pulls all repos under the GitHub `dsh-plugin` topic (the community channel documented by DeepSeek official docs)
- **Deterministic security pre-scan**: clicking "Audit & Install" triggers a host-side static scan (install scripts / entry code / dependencies / owner reputation); the report rides along with the audit prompt — see "Deterministic security pre-scan" below
- **Plugin detection + "Plugins only"**: background progressive detection of whether a repo is a real DSH plugin (deterministic package.json signature); cards get "Plugin✓/Not a plugin✗" badges; a "Plugins only" toggle filters out unrelated repos — see "Plugin detection" below
- **Reputation badges**: personal account, star/fork anomaly (suspected star farming) visible directly on cards
- **Category browsing**: 7 functional categories + Other (regex-based on name/topics/description)
- **Scenario config**: 5 usage scenarios with scenario-based filtering (see "Scenario design" below)
- **Chinese-English synonym search**: a 38-word mapping table so Chinese keywords hit English plugin data
- **Official/community badges**: `deepseek-ai` official blue badge vs. community outlined badge
- **Installed marker**: reads profile manifest bundles to distinguish built-in from user-installed
- **LLM-audited install**: one-click generation of an audit prompt for the LLM (carrying the deterministic pre-scan report); install on pass, stop on risk; built-in Markdown renderer previews README + GitHub external links
- **Check updates**: generates an update-check prompt for installed plugins — compare versions, audit the changelog, **and re-run security review before updating** (compare old/new dependencies/code/permission changes, watch for supply-chain poisoning; only run `dsh plugin update` after passing, stop on risk)
- **Listing cache**: 5-minute server-side TTL (`?force=1` to force refresh) + 10-minute client sessionStorage + 24-hour plugin-verdict disk cache
- **i18n**: zh / en bilingual UI

---

## Deterministic security pre-scan

When "Audit & Install" is clicked, the host fetches repo metadata, `package.json`, and entry/script file text in a **read-only** manner, runs a static rule engine, and outputs a structured risk report (`safe` / `review` / `caution`) + a signal list + evidence snippets (script content / matched code lines). The report is sent to the LLM with the audit prompt as anchors.

### Rules

| Severity | Category | Rule |
|---|---|---|
| 🔴 High | Install script | `install/postinstall/prepare` script with **download-and-execute** (`curl\|sh`, `node -e`) pattern |
| 🔴 High | Install script | Script **writes sensitive paths / reads secrets** (`~/.ssh`, `.env`, `~/.bashrc`, …) |
| 🔴 High | Entry code | Writes `~/.ssh` / shell config (classic persistence backdoor) |
| 🔴 High | Entry code | **base64-decoded execution** (classic static-detection evasion) |
| 🔴 High | Reputation | Owner account **created < 90 days ago** (brand-new account publishing a plugin = high-confidence malicious distribution) |
| 🟡 Watch | Install script | Install script exists (manual review needed), inline code execution |
| 🟡 Watch | Entry code | `eval`/`Function` dynamic execution, `child_process`/`spawn`, reading secret files, requests to non-allowlisted domains |
| 🟡 Watch | Dependency | > 50 dependencies, **typosquatting** (name within edit distance ≤ 2 of core packages like `@deepseek-ai/*`/`cordis`), `file:`/`git:` refs |
| 🟡 Watch | Reputation | Repo created < 30 days ago, young account with low followers, **star/fork ratio anomaly** (high stars, low forks = suspected star farming) |
| 🔵 Info | Metadata | Personal-account repo, no `package.json` (may not be a standard npm plugin), local/repo dependency refs |

### Implementation notes

- **Read-only**: everything comes from `api.github.com` + `raw.githubusercontent.com` text fetches — **no repo code is ever executed**
- **Cache**: pre-scan results cached per-repo for 24h; re-reviewing is instant
- **Degradation**: fetch failure / network error returns an empty report; the LLM can still audit (without anchors)
- **Signal philosophy**: pattern signals "mark, don't condemn" — evidence snippets go to the LLM for confirmation; factual signals have zero false positives

---

## Plugin detection

The GitHub `dsh-plugin` **topic tag is unreliable** — any repo can tag itself, and big repos (the kernel, unrelated projects) get mis-tagged or tag-squatted into the list. But a real DSH plugin has a **machine-verifiable deterministic signature** in its `package.json`:

| Signature | Note |
|---|---|
| `dsh` field (top level) | The plugin-spec field declaring `bundle.patch` / `client.inject` |
| `@deepseek-ai/cordis` dependency | cordis runtime in `peerDependencies` or `dependencies` |

Either present → verified DSH plugin (✓); neither → not a plugin (✗).

### Progressive background scan (never slows the listing)

```
listing returns (concurrent fetch, 2-3s) → list renders instantly
  → host scans in background, concurrency 8, pulling each package.json (raw.githubusercontent, no api.github.com quota)
  → cards progressively gain "Plugin✓ / Not a plugin✗" badges + a top progress bar "Verifying plugins 12/300"
  → on completion results persist to disk (~/.dsh/profiles/<profile>/dsh-discovery-plugins.json, 24h)
  → next open reads the cache; no re-scan needed
```

- **"Plugins only" toggle**: scanning never changes the sort (stars, descending, unchanged); verified plugins slot in by star; unverified ones sink to a "pending" section (taking no sort slots, joining automatically once confirmed); non-plugins hidden. List keys reuse DOM — result inflow causes **no layout jumping**
- **Failure semantics**: repo 404 / no `package.json` → deterministically "not a plugin"; network failure → recorded `unknown` (treated as unverified, **never persisted as a verdict**, retried after a 10-minute cooldown)
- **Orthogonal to search/categories**: the plugin toggle is an independent filter dimension, independent of keyword and category tabs

---

## Fetch rules

The data source is the GitHub official API `dsh-plugin` topic search (the only authoritative entry for community plugins):

| Rule | Value |
|---|---|
| Source | `GET /search/repositories?q=topic:dsh-plugin` |
| Sort | by stars descending (`sort=stars&order=desc`) |
| Scope | 30 per page, **10 pages fetched concurrently (~300 repos)** |
| Per-request timeout | 10s (`AbortSignal.timeout`) |
| Failure fallback | concurrent fetch (`Promise.allSettled`); failed pages are dropped, **remaining pages still return** |
| Server cache | 5-min TTL; `?force=1` forces refresh |
| Field mapping | name / owner / description / stars / language / updatedAt / htmlUrl / topics / **ownerType / repoCreatedAt / forks / isPlugin** |
| README fetch | `GET /repos/{owner}/{repo}/readme` (raw), 5-min TTL, 404 cached as error |
| Plugin-detection fetch | `raw.githubusercontent.com/{owner}/{repo}/{main\|master}/package.json` (no API quota) |

> Design intent: fetching is **read-only and bounded** — no crawling of files inside repos, no execution of repo code, pagination capped, timeouts and degradation preserve the experience.

## Categorization rules

Regex matching on `name + topics + description` (first 400 chars), 7 categories + Other:

| Category | Example keywords |
|---|---|
| UI Enhancement | sidebar / ui / theme / skin / panel / overlay / web-ui |
| Terminal | terminal / tui / shell / cli / console / bash |
| Tools & Capabilities | tool / skill / command / automation / workflow |
| Memory | memory / recall / remember / store / kv / vector |
| Models & Integration | model / provider / llm / api / gateway / inference |
| Notifications & Integration | notify / webhook / slack / wechat / feishu / telegram / dingtalk |
| Development & Runtime | dev / runtime / debug / inspect / code / git / docker / sandbox |
| Other | matches none of the above |

## Search rules

Plugin data is in English (name/description/topics), so Chinese users searching with Chinese keywords would miss English content. A built-in **38-word Chinese-English synonym table** maps Chinese keywords (e.g. 记忆 / 通知 / 模型) to a set of English keywords for matching. Supports: direct category-name matching, synonym expansion, full-text matching across name/owner/description/topics; results sorted by stars descending.

## Official badge rules

Only **`deepseek-ai`** (DeepSeek's official GitHub organization) is marked official. Note: the bare account `deepseek` is a dormant placeholder account (public_repos = 0) and is **deliberately not marked official** — to avoid mistaking impersonator/placeholder accounts for official channels.

---

## Scenario design

Community plugins follow a long-tail distribution: one keyword search can hit dozens of similar plugins with heavy functional overlap. Scenarios solve the "what to install" choice problem — mapping 5 common usage intents to plugin functional clusters, with automatic dedup and limited recommendations:

### Scenarios and functional clusters

| Scenario | Functional keyword cluster |
|---|---|
| ✍️ Writing | write / note / memory / template / blog / doc / content / skill / memo / recall |
| 💻 Development | terminal / git / docker / code / debug / runtime / sandbox / browser / cli / tui / shell |
| 🧠 Model integration | model / provider / llm / api / gateway / inference / openai / anthropic / gemini / claude |
| ⚙️ Automation | tool / workflow / schedule / task / agent / pipeline / command / todo / job |
| 🔔 Notification integration | notify / webhook / slack / wechat / feishu / telegram / dingtalk / email / push / im |

### Filtering rules

For each scenario:

1. **Match**: plugin name/description/topics hit the scenario regex → candidate
2. **Group**: plugin is assigned to the first functional keyword cluster it hits (anything unmatched goes to `other`)
3. **Per-cluster cap**: top **3** by stars (`MAX_PER_FUNCTION`) ∪ **1** recently-updated new project (`NEW_PROJECTS_PER_FUNCTION`, deduplicated against the top-stars picks)
4. **Aggregate sort**: all selected plugins sorted by stars descending (tie-break: update time); the candidate list carries reputation annotations (personal account / star anomaly)

### Design intent

- **Deduplication**: only 3 high-star plugins per functional cluster, avoiding a screen full of homogeneous plugins
- **Don't ignore new projects**: each cluster reserves 1 "recently updated" slot — a pure star threshold would permanently drown out young but active new plugins
- **Scenario trimming**: each scenario ends with 10–20 curated plugins; for "one-click install" the LLM first checks reputation signals, skips candidates hitting the hard security gate, then audits, dedupes, and installs the rest (see audit flow above)

---

## Install

```sh
# From GitHub (first install requires allowing the build; dsh will prompt you to add the package key to the profile's pnpm-workspace.yaml allowBuilds)
dsh plugin add github:EricXu20266/dsh-discovery

# Or from npm (prebuilt artifacts, no build authorization needed)
dsh plugin add dsh-discovery
```

## Usage

After installing, restart the dsh session and the "Plugin Discovery" entry appears in the sidebar — click it to open the full-screen discovery browser.

## Development

```sh
pnpm install
pnpm build          # tsc compiles host side → lib/
pnpm bundle:client  # tsdown bundles client side → client/client.js
```

## License

MIT

# dsh-discovery

> 🌐 **English | [中文](README.md)**

DSH community plugin discovery browser — a read-only tool for browsing and searching DeepSeek Harness community plugins.

> **Core positioning: LLM-audited install.** DHS currently has no official plugin marketplace, and any third-party plugin is essentially "executable code". This tool is therefore deliberately **read-only**: it only discovers, filters, and searches plugins; **security review is done by the LLM (DHS's agent)** — leveraging the LLM's code-understanding and security-analysis abilities to read the source, inspect dependencies, identify malicious patterns, and only install after the review passes.

---

## Why the "LLM-audited install" model

Plugins are code injected directly into the DHS host process. Once installed, they have the same local privileges as you (reading files, running commands, accessing the network). Without an official marketplace providing code audit and signing endorsement, trust in third-party plugins can only come from "checking before installing". Manually reading every repo's source is prohibitively expensive, and LLMs happen to have source-level security-analysis capability — **so the review step is delegated to the LLM; this is the core design of this tool**.

dsh-discovery itself maintains a strict read-only boundary: it never installs, updates, uninstalls, or loads any remote code — all interactions with repositories are limited to fetching listings, fetching README text, and opening external links. **Review and installation are entirely performed by the LLM within the session**, and the user always sees the LLM's review process and conclusion.

### Audit flow

```
Discover → Filter → One-click submit → LLM audit → Pass / Reject
 │          │          │               │          ├─ Pass: LLM runs dsh plugin add to install
 │          │          │               └──────────└─ Risk found: LLM lists risk points and stops
 │          │          └───────────────  generates audit prompt, sends into current session
 │          └──────────────────  categorize / search / scenario filter
 └──────────────────────────────  browse GitHub `dsh-plugin` community topic
```

1. **Browse/Search**: browse community plugins by category, keyword, or scenario (read-only; never loads remote code)
2. **One-click submit**: click "Audit & Install" → auto-generates an audit prompt sent to the current session for the LLM
3. **LLM audit** (mandated by the audit prompt):
   - **No malicious behavior**: abnormal network requests, file reads/writes, env-var/secret theft, command execution
   - **Matches description**: no hidden backdoors
   - **License & dependency safety**
4. **Execute or reject**: review passed → the LLM installs the plugin with `dsh plugin add`; risk found → the LLM lists risk points and **stops the installation**
5. **Scenario batch follows the same path**: for "one-click scenario install", the LLM first reviews each candidate repo's safety one by one, then deduplicates, filters, and installs

> In essence this **uses the LLM's capability for security checks** — upgrading the whole "read repo, judge risk, execute install" chain from manual labor to LLM-driven; the user simply sees the review conclusion in the session and confirms or interrupts.

---

## Features

- **Community plugin browsing**: pulls all repos under the GitHub `dsh-plugin` topic (the community channel documented by DeepSeek official docs)
- **Category browsing**: 7 functional categories + Other (regex-based on name/topics/description)
- **Scenario config**: 5 usage scenarios with scenario-based filtering (see "Scenario design" below)
- **Chinese-English synonym search**: a 38-word mapping table so Chinese keywords hit English plugin data
- **Official/community badges**: `deepseek-ai` official blue badge vs. community outlined badge
- **Installed marker**: reads profile manifest bundles to distinguish built-in from user-installed
- **LLM-audited install**: one-click generation of an audit prompt for the LLM (read source / inspect deps / identify malicious patterns); install on pass, stop on risk; built-in Markdown renderer previews README + GitHub external links
- **Check updates**: generates an update-check prompt for installed plugins — compare versions, audit the changelog, **and re-run security review before updating** (compare old/new dependencies/code/permission changes, watch for supply-chain poisoning; only run `dsh plugin update` after passing, stop on risk)
- **Listing cache**: 5-minute server-side TTL (`?force=1` to force refresh) + 10-minute client sessionStorage
- **i18n**: zh / en bilingual UI

---

## Fetch rules

The data source is the GitHub official API `dsh-plugin` topic search (the only authoritative entry for community plugins):

| Rule | Value |
|---|---|
| Source | `GET /search/repositories?q=topic:dsh-plugin` |
| Sort | by stars descending (`sort=stars&order=desc`) |
| Scope | 30 per page, **max 10 pages (~300 repos)** |
| Per-request timeout | 10s (`AbortSignal.timeout`) |
| Failure fallback | a failed page fetch stops pagination immediately and **returns what was fetched so far** (transient errors don't kill the whole listing) |
| Server cache | 5-min TTL; `?force=1` forces refresh |
| Field mapping | name / owner / description / stars / language / updatedAt / htmlUrl / topics |
| README fetch | `GET /repos/{owner}/{repo}/readme` (raw), 5-min TTL, 404 cached as error |

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
4. **Aggregate sort**: all selected plugins sorted by stars descending (tie-break: update time)

### Design intent

- **Deduplication**: only 3 high-star plugins per functional cluster, avoiding a screen full of homogeneous plugins
- **Don't ignore new projects**: each cluster reserves 1 "recently updated" slot — a pure star threshold would permanently drown out young but active new plugins
- **Scenario trimming**: each scenario ends with 10–20 curated plugins; for "one-click install" the LLM reviews each one for safety before dedup-filter-install (see audit flow above)

---

## Install

```sh
# From GitHub (first install requires allowing the build; dsh will prompt you to add the package key to the profile's pnpm-workspace.yaml allowBuilds)
dsh plugin add github:EricXu20266/dsh-discovery

# Or from npm (prebuilt artifacts, no build authorization needed)
dsh plugin add dsh-discovery
```

## Usage

After installing, restart the dsh session and the "Plugin Marketplace" entry appears in the sidebar — click it to open the full-screen discovery browser.

## Development

```sh
pnpm install
pnpm build          # tsc compiles host side → lib/
pnpm bundle:client  # tsdown bundles client side → client/client.js
```

## License

MIT

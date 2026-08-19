# dsh-discovery

> 🌐 **中文 | [English](README.en.md)**

DSH 社区插件搜索器（DSH plugin discovery browser）——浏览与检索 DeepSeek Harness 社区插件的只读工具。

> **核心定位：双层防御——确定性预检 + LLM 审计安装。** DHS 目前没有官方插件市场，任何第三方插件本质上都是「可执行代码」。本工具刻意做成**只读**，安全审查采用两层模型：**代码层**用静态规则做确定性预检（收集事实信号，不判刑），**模型层**由 LLM（DHS 的 agent）带着预检报告做深度审查（读源码、查依赖、识别恶意模式），审查通过才执行安装。

> ⚠️ **免责声明：预防措施 ≠ 安全保障。** 本工具的筛选、确定性预检与 LLM 审查均为**预防性措施**，无法穷尽所有恶意行为——道高一尺，魔高一丈。第三方插件本质上是可在你机器上执行任意操作的代码。**安装前请务必保持警惕：不随意安装来源不明的插件，不向插件泄露敏感信息（API Key、密钥、个人数据），安装后留意异常行为。** 使用本工具即视为你已知悉并自行承担相应风险。

---

## 为什么是「确定性预检 + LLM 审计」双层模型

插件是直接注入 DHS host 运行的代码，一旦安装就拥有与你相同的本机权限（读文件、跑命令、访问网络）。没有官方市场做代码审计与签名背书时，第三方插件的信任只能靠「装之前查一遍」。

社区生态中恶意插件（供应链投毒、账号盗用后投毒、刷星伪装）越来越多，**只靠 LLM 每次从零读源码**审查会漏——LLM 可能只看 README（README 可伪造），且没有明确锚点。因此拆成两层：

| 层 | 谁做 | 干什么 | 特点 |
|---|---|---|---|
| **L0 元数据信号** | 代码 | 列表页直接展示 owner 类型 / 账号与仓库年龄 / star-fork 比 | 零额外请求（GitHub search API 自带字段） |
| **L1 确定性预检** | 代码 | 静态规则扫描仓库：安装脚本、入口代码危险模式、依赖投毒、owner 信誉 | 确定性、可缓存、快——**标记不判刑** |
| **L2 LLM 深度审查** | LLM | 带 L1 报告逐项读码确认，最终裁决 | 理解语义、看上下文、下结论 |

> **信号哲学**：静态规则检出模式时**只标记、不判死刑**——把证据（脚本内容、代码片段、文件位置）原样喂给 LLM 复核。误报的代价是 LLM 多看一眼，漏报的代价是供应链投毒。事实类信号（脚本存在、账号年龄、依赖拼写相似）零误报。

dsh-discovery 自身保持严格的只读边界：不安装、不更新、不卸载、不加载任何远程代码——所有与仓库的交互只有拉 listing、拉 README/package.json 文本、打开外部链接。**审查与安装动作全部由 LLM 在会话内完成**，用户始终能看到 LLM 的审查过程与结论。

### 审计流程

```
发现 → 筛选 → 一键交审 → 确定性预检 → LLM 深度审查 → 通过 / 拒绝
 │      │         │          │             │          ├─ 通过：LLM 执行 dsh plugin add 安装
 │      │         │          │             └──────────└─ 有风险：LLM 列出风险点并停止安装
 │      │         │          └───── host 静态扫描（~1-2s），报告随 prompt 发进会话
 │      │         └──────────────────── 生成审查 prompt，发进当前会话
 │      └──────────────────────── 分类 / 搜索 / 场景筛选
 └──────────────────────────────── 浏览 GitHub `dsh-plugin` 社区话题
```

1. **浏览/搜索**：按分类、关键词、场景浏览社区插件（只读，不加载任何远程代码）
2. **一键交审**：点「审查安装」→ host 先跑确定性预检（按钮显示「预检中…」，约 1-2 秒）→ 预检报告随审查 prompt 一起发进会话
3. **LLM 深度审查**（审查 prompt 强制要求，且**禁止只看 README**）：
   - 携带 L1 预检信号清单与证据片段，逐项复核
   - **安装脚本**：`install/postinstall/prepare` 是否存在？是否涉及下载执行、写敏感路径、窃取密钥？
   - **入口代码**：`eval`/动态执行、`child_process`、写 `~/.ssh` 或 shell 配置、读取并外发 `.env`/API key？
   - **依赖安全**：typosquatting（依赖名与核心包相似）、数量异常、`file:`/`git:` 引用来源
   - **网络行为**：外链域名用途（遥测上报 vs 数据窃取）
   - **相符性**：功能与 README 声明一致，无隐藏行为
   - **owner 信誉**：结合账号年龄与仓库活跃度判断
4. **执行或拒绝**：审查通过 → LLM 用 `dsh plugin add` 安装；**预检评级为高危（🔴）时默认拒绝，除非 LLM 读码后确认风险可控**；发现风险 → 列出风险点并停止安装
5. **场景批量同理**：「场景一键安装」时 LLM 先核对信誉信号，**命中安全硬门槛（全新账号/安装脚本下载执行/写敏感路径/typosquatting/刷星特征）的候选直接跳过**，再对剩余候选审查、去重、安装

---

## 功能

- **社区插件浏览**：拉取 GitHub `dsh-plugin` 话题下全部仓库（DeepSeek 官方文档记载的社区渠道）
- **确定性安全预检**：点「审查安装」时 host 静态扫描仓库（安装脚本/入口代码/依赖/owner 信誉），报告随审查 prompt 进会话——详见「确定性安全预检」章节
- **插件判定 + 只看插件**：后台渐进判定仓库是否为真 DSH 插件（package.json 确定性签名），卡片标记「插件✓/非插件✗」，「只看插件」开关一键过滤无关仓库——详见「插件判定」章节
- **信誉信号徽章**：个人账号、星数/fork 异常（疑似刷星）在卡片直接可见
- **分类浏览**：7 类功能分类 + 其他（基于名称/话题/描述正则归属）
- **场景配置**：5 个使用场景 + 场景化筛选（见下文「场景化设计」）
- **中英同义词搜索**：38 词映射表，中文关键词也能命中英文插件数据
- **官方/第三方标记**：`deepseek-ai` 官方蓝底 vs 社区描边
- **已安装标识**：读 profile manifest bundles，区分内置与用户安装
- **LLM 审查安装**：一键生成审查 prompt 交 LLM（携带确定性预检报告），通过则装、有风险则停；内置 Markdown 渲染器预览 README + GitHub 外链
- **检查更新**：已安装插件生成更新检查 prompt 交 LLM——对比版本、审查 changelog，**更新前同样执行安全审查**（对比新旧依赖/代码/权限变更，警惕供应链投毒，通过才 `dsh plugin update`，有风险则停止）
- **listing 缓存**：服务端 5 分钟 TTL（`?force=1` 强制刷新）+ 客户端 sessionStorage 10 分钟 + 插件判定磁盘缓存 24 小时
- **i18n**：zh / en 双语界面

---

## 确定性安全预检

「审查安装」时，host 以**只读**方式拉取仓库元数据、`package.json`、入口与脚本文件文本，跑静态规则引擎，输出结构化风险报告（`safe` / `review` / `caution`）+ 信号清单 + 证据片段（脚本内容/代码命中行）。报告随审查 prompt 发给 LLM 作为锚点。

### 规则清单

| 严重度 | 类别 | 规则 |
|---|---|---|
| 🔴 高危 | 安装脚本 | `install/postinstall/prepare` 脚本存在**下载并执行**（`curl\|sh`、`node -e`）模式 |
| 🔴 高危 | 安装脚本 | 脚本**写入敏感路径 / 读取密钥**（`~/.ssh`、`.env`、`~/.bashrc` 等） |
| 🔴 高危 | 入口代码 | 写入 `~/.ssh` / shell 配置（持久化后门典型行为） |
| 🔴 高危 | 入口代码 | **base64 解码后执行**（规避静态检测的经典手法） |
| 🔴 高危 | owner 信誉 | owner 账号**创建不足 90 天**（全新账号发布插件 = 恶意分发高置信特征） |
| 🟡 关注 | 安装脚本 | 存在安装脚本（内容需人工复核）、内联代码执行 |
| 🟡 关注 | 入口代码 | `eval`/`Function` 动态执行、`child_process`/`spawn`、读取密钥文件、请求非白名单域名 |
| 🟡 关注 | 依赖 | 依赖数量 > 50、**typosquatting**（依赖名与 `@deepseek-ai/*`/`cordis` 等核心包编辑距离 ≤ 2）、`file:`/`git:` 引用 |
| 🟡 关注 | 信誉 | 仓库创建不足 30 天、账号较新且关注度低、**star/fork 比异常**（高 star 低 fork，疑似刷星） |
| 🔵 提示 | 元数据 | 个人账号仓库、无 `package.json`（可能非标准 npm 插件）、依赖含本地/仓库引用 |

### 实现要点

- **只读**：全部通过 `api.github.com` + `raw.githubusercontent.com` 拉文本，**不执行任何仓库代码**
- **缓存**：预检结果 24h TTL（按仓库缓存），重复审查秒回
- **降级**：仓库拉取失败/网络异常返回空报告，LLM 仍可审查（无锚点）
- **信号哲学**：模式类信号「标记不判刑」，证据片段喂给 LLM 复核；事实类信号零误报

---

## 插件判定

GitHub 的 `dsh-plugin` **topic 标签不可靠**——任何仓库都能手动打标签，大仓库（内核、无关项目）也会被误标/蹭标混入列表。但真 DSH 插件在 `package.json` 里有**机器可验证的确定性签名**：

| 签名 | 说明 |
|---|---|
| `dsh` 字段（顶层） | 声明 `bundle.patch` / `client.inject` 的插件规范字段 |
| `@deepseek-ai/cordis` 依赖 | `peerDependencies` 或 `dependencies` 含 cordis 运行时 |

命中其一 → 确认为 DSH 插件（✓）；两者皆无 → 非插件（✗）。

### 渐进式后台扫描（不拖慢列表加载）

```
listing 返回（并发拉取，2-3s） → 列表照常显示
  → host 后台并发 8 逐个拉 package.json（raw.githubusercontent，不耗 api.github.com 配额）
  → 卡片逐个浮现「插件✓/非插件✗」标记 + 顶部进度条「插件确认中 12/300」
  → 扫描完成结果落盘（~/.dsh/profiles/<profile>/dsh-discovery-plugins.json，24h 有效）
  → 下次打开直接读缓存，无需重扫
```

- **「只看插件」开关**：扫描不改变排序（star 降序不变），已确认插件按 star 正常入列；未确认的沉底「待确认区」（不占排序位，确认后自动按 star 插入）；非插件隐藏。列表 key 复用 DOM，结果回流**无跳动**
- **失败语义**：仓库 404 / 无 package.json → 确定性「非插件」；网络失败 → 记 `unknown`（视同未判定，**不写盘固化**，10 分钟冷却后自动重试）
- **与搜索/分类正交**：插件开关是独立过滤维度，与关键词、分类 Tab 互不干扰

---

## 拉取规则

数据源是 GitHub 官方 API 的 `dsh-plugin` 话题搜索（社区插件的唯一权威入口），规则如下：

| 规则 | 取值 |
|---|---|
| 数据源 | `GET /search/repositories?q=topic:dsh-plugin` |
| 排序 | 按 star 数降序（`sort=stars&order=desc`） |
| 拉取范围 | 每页 30 条，**10 页并发拉取（约 300 个仓库）** |
| 单请求超时 | 10 秒（`AbortSignal.timeout`） |
| 失败降级 | 并发拉取（`Promise.allSettled`），失败页自动丢弃，**其余页正常返回** |
| 服务端缓存 | 5 分钟 TTL；`?force=1` 可强制刷新 |
| 字段映射 | name / owner / description / stars / language / updatedAt / htmlUrl / topics / **ownerType / repoCreatedAt / forks / isPlugin** |
| README 拉取 | `GET /repos/{owner}/{repo}/readme`（raw），5 分钟 TTL，404 缓存错误 |
| 插件判定拉取 | `raw.githubusercontent.com/{owner}/{repo}/{main\|master}/package.json`（不耗 API 配额） |

> 设计意图：拉取**只读 + 有界**——不爬取仓库内文件、不执行任何仓库代码、分页有上限、超时与降级保证体验。

## 分类规则

基于 `name + topics + description`（前 400 字符）正则匹配，7 类 + 其他：

| 分类 | 匹配关键词示例 |
|---|---|
| UI 增强 | sidebar / ui / theme / skin / panel / overlay / web-ui |
| 终端 | terminal / tui / shell / cli / console / bash |
| 工具与能力 | tool / skill / command / automation / workflow |
| 记忆 | memory / recall / remember / store / kv / vector |
| 模型与接入 | model / provider / llm / api / gateway / inference |
| 通知与集成 | notify / webhook / slack / wechat / feishu / telegram / dingtalk |
| 开发与运行时 | dev / runtime / debug / inspect / code / git / docker / sandbox |
| 其他 | 未命中上述任何规则 |

## 搜索规则

插件数据是英文的（name/description/topics），中文用户搜中文词会漏掉英文内容。因此内置 **38 词中英同义词表**：输入中文关键词（如「记忆」「通知」「模型」）时自动映射到一组英文关键词匹配，支持：分类名直配、同义词展开、名称/所有者/描述/话题全文匹配，结果按 star 降序。

## 官方标记规则

只有 **`deepseek-ai`**（DeepSeek 官方 GitHub 组织）标记为官方。注意：裸账号 `deepseek` 是休眠占位账户（public_repos = 0），**刻意不标记为官方**——避免把冒牌/占位账号误判为官方渠道。

---

## 场景化设计

社区插件是长尾分布：搜一个关键词可能命中几十个相似插件，功能重叠严重。场景化解决「装什么」的选择困难——把 5 个常见使用意图映射到插件功能簇，自动去重、限量推荐：

### 场景与功能簇

| 场景 | 功能关键词簇 |
|---|---|
| ✍️ 写作 | write / note / memory / template / blog / doc / content / skill / memo / recall |
| 💻 开发 | terminal / git / docker / code / debug / runtime / sandbox / browser / cli / tui / shell |
| 🧠 模型接入 | model / provider / llm / api / gateway / inference / openai / anthropic / gemini / claude |
| ⚙️ 自动化 | tool / workflow / schedule / task / agent / pipeline / command / todo / job |
| 🔔 通知集成 | notify / webhook / slack / wechat / feishu / telegram / dingtalk / email / push / im |

### 筛选规则

对每个场景：

1. **匹配**：插件 name/description/topics 命中场景正则 → 进入候选
2. **分组**：插件归入第一个命中的功能关键词簇（未命中任何关键词的归入 `other`）
3. **每簇限量**：高星前 **3** 个（`MAX_PER_FUNCTION`）∪ 最近更新前 **1** 个新项目（`NEW_PROJECTS_PER_FUNCTION`，与高星去重）
4. **汇总排序**：全部选中插件按 star 降序（并列按更新时间），候选清单带信誉信号标注（个人账号/星数异常）

### 设计意图

- **去重**：同一功能簇的高星插件只留 3 个，避免一屏全是同质化插件
- **不忽略新项目**：每个功能簇额外留 1 个「最近更新」名额——纯 star 阈值会永远淹没刚起步但活跃的新插件
- **场景精简**：每个场景最终 10~20 个精选，「一键安装」时 LLM 先核对信誉信号 + 命中安全硬门槛跳过，再对剩余候选审查、去重、安装（详见上文审计流程）

---

## 安装

```sh
# 从 GitHub 安装（首次需要允许构建，dsh 会给出提示，把包 key 加入 profile 的 pnpm-workspace.yaml allowBuilds）
dsh plugin add github:EricXu20266/dsh-discovery

# 或从 npm 安装（预构建产物，无需授权）
dsh plugin add dsh-discovery
```

## 使用

安装后重启 dsh 会话，侧边栏出现「插件搜索」入口，点击打开全屏搜索浏览器。

## 开发

```sh
pnpm install
pnpm build          # tsc 编译 host 侧 → lib/
pnpm bundle:client  # tsdown 打包 client 侧 → client/client.js
```

## 许可

MIT

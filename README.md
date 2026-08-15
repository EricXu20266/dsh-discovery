# dsh-discovery

DSH 社区插件搜索器（DSH plugin discovery browser）——浏览与检索 DeepSeek Harness 社区插件的只读工具。

> **核心定位：审计后安装（audit-then-install）。** DHS 目前没有官方插件市场，任何第三方插件本质上都是「可执行代码」。因此本工具刻意做成**只读**：只帮你发现、筛选、审查插件，**绝不代执行安装**——安装永远由你在预览仓库后，用 `dsh plugin add <spec>` 自己完成。

---

## 为什么是「审计安装」模型

插件是直接注入 DHS host 运行的代码，一旦安装就拥有与你相同的本机权限（读文件、跑命令、访问网络）。没有官方市场做代码审计与签名背书时，第三方插件的信任只能靠「装之前看一遍」。

所以 dsh-discovery 的安全设计围绕一条铁律展开：

> **本工具不安装、不更新、不卸载、不加载任何远程代码。** 所有与仓库的交互只读：拉 listing、拉 README 文本、打开外部链接。

### 审计流程（推荐路径）

```
发现 → 筛选 → 审查 → 决定 → 安装
 │      │       │       │       └─ 用户执行：dsh plugin add github:<owner>/<repo>
 │      │       │       └─────── 判断：官方标记？star 数？最近更新？
 │      │       └─────────────── 内置 Markdown 渲染器预览仓库 README
 │      └─────────────────────── 分类 / 搜索 / 场景筛选
 └────────────────────────────── 浏览 GitHub `dsh-plugin` 社区话题
```

1. **浏览/搜索**：按分类、关键词、场景浏览社区插件
2. **预览 README**：点「审查安装」在面板内直接渲染仓库 README（GitHub 禁止 iframe 嵌入，故用内置渲染器），不离开应用
3. **看来源**：官方（`deepseek-ai` 组织，蓝底标识）vs 社区（描边标识）
4. **去仓库看代码**：点「查看仓库」跳转 GitHub，检查源码、构建脚本、依赖声明
5. **自行安装**：确认安全后，在终端执行 `dsh plugin add github:<owner>/<repo>`

---

## 功能

- **社区插件浏览**：拉取 GitHub `dsh-plugin` 话题下全部仓库（DeepSeek 官方文档记载的社区渠道）
- **分类浏览**：7 类功能分类 + 其他（基于名称/话题/描述正则归属）
- **场景配置**：5 个使用场景 + 场景化筛选（见下文「场景化设计」）
- **中英同义词搜索**：38 词映射表，中文关键词也能命中英文插件数据
- **官方/第三方标记**：`deepseek-ai` 官方蓝底 vs 社区描边
- **已安装标识**：读 profile manifest bundles，区分内置与用户安装
- **审查安装 / 查看仓库**：内置 Markdown 渲染器预览 README + GitHub 外链
- **检查更新**：已安装插件生成更新检查 prompt
- **listing 缓存**：服务端 5 分钟 TTL（`?force=1` 强制刷新）+ 客户端 sessionStorage 10 分钟
- **i18n**：zh / en 双语界面

---

## 拉取规则

数据源是 GitHub 官方 API 的 `dsh-plugin` 话题搜索（社区插件的唯一权威入口），规则如下：

| 规则 | 取值 |
|---|---|
| 数据源 | `GET /search/repositories?q=topic:dsh-plugin` |
| 排序 | 按 star 数降序（`sort=stars&order=desc`） |
| 拉取范围 | 每页 30 条，**最多 10 页（约 300 个仓库）** |
| 单请求超时 | 10 秒（`AbortSignal.timeout`） |
| 失败降级 | 单页拉取失败立即停止翻页，**返回已拉到的部分**（transient 错误不拖垮整个 listing） |
| 服务端缓存 | 5 分钟 TTL；`?force=1` 可强制刷新 |
| 字段映射 | name / owner / description / stars / language / updatedAt / htmlUrl / topics |
| README 拉取 | `GET /repos/{owner}/{repo}/readme`（raw），5 分钟 TTL，404 缓存错误 |

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
4. **汇总排序**：全部选中插件按 star 降序（并列按更新时间）

### 设计意图

- **去重**：同一功能簇的高星插件只留 3 个，避免一屏全是同质化插件
- **不忽略新项目**：每个功能簇额外留 1 个「最近更新」名额——纯 star 阈值会永远淹没刚起步但活跃的新插件
- **场景精简**：每个场景最终 10~20 个精选，用户按场景一键获得「该装什么」的清单，再逐个人工审计安装

---

## 安装

```sh
# 从 GitHub 安装（首次需要允许构建，dsh 会给出提示，把包 key 加入 profile 的 pnpm-workspace.yaml allowBuilds）
dsh plugin add github:EricXu20266/dsh-discovery

# 或从 npm 安装（预构建产物，无需授权）
dsh plugin add dsh-discovery
```

## 使用

安装后重启 dsh 会话，侧边栏出现「插件市场」入口，点击打开全屏搜索浏览器。

## 开发

```sh
pnpm install
pnpm build          # tsc 编译 host 侧 → lib/
pnpm bundle:client  # tsdown 打包 client 侧 → client/client.js
```

## 许可

MIT

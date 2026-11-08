# py-changes.md

> py 的改动记录：这个 fork 相对上游 `jj-view` 做了哪些**功能变更**、为什么这样做、以及**怎么开发/验证**。
> 最后更新：2026-11-03

---

## 0. 定位

| 维度    | 选择                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 平台    | 只支持 **Windows 11 x64**，不再产出跨平台包                                                                                      |
| 网络    | **完全本地化**：不读取远端状态（PR/MR、CI、评论），仅保留手动上传（`jj git push`）                                               |
| UI 入口 | 活动栏 **JJ View** 容器（Repositories / Changes / JJ Log），原生 SCM 默认不注册                                                  |
| 发布    | 当前只产出本地 VSIX（`pnpm package`）；`release` / `ovsx` / `release:*` 脚本与依赖**保留**，后续可能发布到 Marketplace / OpenVSX |

核心思路：**扩展命令层与数据层不变，新增一个活动栏容器作为主要 UI，原生 SCM 与 Code Forge 降级为可选开关。**

---

### 0.1 身份与许可（相对上游）

| 项                   | 值                                                           |
| -------------------- | ------------------------------------------------------------ |
| 扩展 ID              | `perphyyoung.jj-view-local`                                  |
| `name` / `publisher` | `jj-view-local` / `perphyyoung`                              |
| `displayName`        | `JJ View Local (unofficial fork)`                            |
| `license` / `author` | `Apache-2.0` / `perphyyoung`                                 |
| `repository`         | `https://github.com/perphyyoung/jj-view`                     |
| 图标                 | 沿用上游 `media/icon.png`（Apache-2.0），README 已声明非官方 |

Apache-2.0 合规要点：

- 保留 `LICENSE` 全文与源文件头部 `Copyright 2026 Google LLC` / SPDX 声明
- README 顶部声明“非官方 fork + 上游链接 + 改动说明”
- 仓库无 `NOTICE` 文件，无需继承额外声明；若上游新增需同步保留
- 命令 / 视图 / 设置 ID 仍沿用 `jj-view.*` 前缀，以兼容上游配置（扩展 ID 已区分，可与上游并存）

## 1. 构建与发布形态

### 1.1 只构建 win32-x64

- `esbuild.js` 的 `installNativeDeps()` 不再下载全部平台 tarball，改为从 pnpm 虚拟存储解析**当前平台**的 `@parcel/watcher-<platform>-<arch>` 并复制到 `dist/node_modules`
- `package.json` 的 `package` 脚本带 `--target win32-x64`，产物名形如 `jj-view-win32-x64-2.10.0.vsix`，manifest 里写入 `TargetPlatform="win32-x64"`
- `tooling/verify-vsix.ts` 只校验本平台的 `watcher.node` 与 `.bat` 脚本

### 1.2 行尾必须为 LF

`biome.json` 要求 `lineEnding: "lf"`，而 Windows 默认 `core.autocrlf=true` 会让检出的工作区全为 CRLF，导致 `pnpm lint` 报数百条格式错误、`pnpm package` 的 prepublish 直接失败。

```powershell
git config core.autocrlf false   # 仅本仓库
# 然后把已检出的文本文件统一转回 LF
```

### 1.3 已移除独立 Web 版

删除了浏览器端产品形态（**不是**删掉 UI 组件库）：

| 删除                                                                                                                         | 说明                     |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `cmd/`、`internal/`、`go.mod`、`go.sum`、`scripts/embed.go`                                                                  | Go 本地 HTTP/WS 服务端   |
| `web/index.html`、`web/src/main.ts`、`web/src/App.svelte`、`web/embed.go`、`web/vite.config.ts`                              | 浏览器入口               |
| `tooling/dev-server.ts`、`tooling/build-web-binaries.ts`、`tooling/setup-sidecar.ts`                                         | 开发/发布脚本            |
| `playwright.web.config.ts`、`src/test/e2e-web/`                                                                              | Web 端 e2e               |
| `web/src/{bridge,commands,details,diff,host,layout,log,notifications,quick-input,settings,sidecar,status,stubs,styles,tabs}` | 仅 standalone 使用的组件 |
| CI 中 `build:server:all`、web binaries artifact、`Run Web E2E Tests`、`dist/release/*`                                       | 对应步骤                 |

`web/` 目录已整体消失：`web/src/scm/**` 与 `web/src/menu/**` 是 Changes 视图复用的组件库，现位于 **`src/core/webview/ui/{scm,menu}/**`**，其测试位于 `src/test/webview/`；同时删除了 `@jj-view/web` 工作区包及其未使用依赖（`@pierre/diffs`、`@pierre/theme`、`shiki`、`@shikijs/*`）。`package.json` 另移除了 `build:web*`、`build:server*`、`build:all`、`dev*`、`setup:sidecar`、`test:e2e:web`。

---

## 2. 功能变更

### 2.1 独立容器：Repositories / Changes / JJ Log

`jj-view-container`（Activity Bar）下三个视图：

| 视图         | id                    | 内容                                                                  |
| ------------ | --------------------- | --------------------------------------------------------------------- |
| Repositories | `jj-view.reposView`   | 每个仓库/工作区一行，常驻显示冲突数（黄）/ 变更数徽标，当前聚焦项高亮 |
| Changes      | `jj-view.changesView` | 只显示**聚焦仓库**的提交输入框与变更分组，标题为 `Changes (repo)`     |
| JJ Log       | `jj-view.logView`     | 已有提交图                                                            |

- 点击 Repositories 中的一行 → `setFocusedRepository` → Changes 自动切换（只由用户显式触发）
- 打开文件**不再**切换聚焦仓库：`onDidChangeActiveDocument` 只用于从打开的编辑器发现仓库，不会改 focus；`followActiveEditor` 开关已删除。多项目下浏览别的项目代码不会把 Changes / JJ Log 带走
- 两个 webview 共用一个 bundle `dist/webview/changes.js`，由 `init` 消息里的 `mode`（`repos` / `changes`）决定渲染内容
- 视图标题栏动作：Changes 有 Commit（✓）/ Refresh / New / Add Workspace；Repositories 有 Add Workspace / Refresh

### 2.2 Changes 视图细节

| 行为           | 实现                                                                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 只显示当前仓库 | provider 只推送 `focusedRoot` 的快照；切换仓库由 `onDidChangeFocusedRepository` 驱动                                                                                                                                                                        |
| 分组           | Merge Conflicts / Working Copy / ancestors；**ancestors 默认折叠**（`ScmPane` 的 `expandAncestors=false`），但拆分产生的新提交所在组会自动展开并滚入视口                                                                                                    |
| 写操作         | 资源级走 `state.command`（`vscode.diff` / `vscode.open`；合并编辑器已移除，见 2.5）；分组级重建 `{ id, rootUri, ancestor, resourceStates }` 后调用既有命令（absorb / squash / abandon / show details / edit / multi-file diff / split above / split below） |
| 右键菜单       | 复用 web 侧 `MenuRegistry` + `WhenEvaluator` + `ContextMenu.svelte`，菜单数据由扩展在 `init` 时注入真实 `package.json` contributes                                                                                                                          |
| 提交输入框     | 单行（约 26px）按行增高，240px 后内部滚动；不拦截 Ctrl+Enter；只有标题栏 ✓ 提交                                                                                                                                                                             |
| 提交链路       | 输入通过 `draft` 消息写入 provider 的**草稿**（`setDraft()`，带 dirty 标记）；标题栏 ✓ 执行 `jj-view.commit`（视图级命令，作用于聚焦仓库）读取该草稿                                                                                                        |
| 草稿不丢       | 刷新/状态推送**不会**覆盖脏草稿（`renderSnapshot` 见 `_draftDirty` 直接跳过）；只有真实 input 事件才上报 draft（挂载/属性同步只重算高度）；提交成功或 `setDescription` 成功后 `clearDraft()`，旧文案不会被下次复用                                          |
| 禁止空提交     | `@` 无改动时一律拒绝提交（与描述是否变化无关）：命令返回 `{ committed: false }`，草稿保留，并通过 `host.ui.showInformation` 提示 `Empty commits are not allowed.`；这也让提交按钮天然幂等 |
| 拆分为新提交   | 文件右键 `Split File into New Commit Above` / `Below`（`jj-view.splitFileIntoCommitAbove/Below`）：`jj squash --from <rev> -A\|-B <rev> -- <file>` + `--keep-emptied`；源提交被搬空也保留，新提交描述留空                                                   |
| 新提交自动展开 | 拆分后比较操作前后 `children`/`parents` 差集得到新 change id，调用 `jj-view.revealChangesGroup`；provider 在 state 里带一次性 `revealChangeId`，webview 展开该组并 `scrollIntoView`                                                                         |
| View as Tree   | 命令 `jj-view.changesAsTree` / `jj-view.changesAsList`，按上下文键 `jj.changesViewAsTree` 互斥显示，模式存 `globalState`（`jj-view.changesViewMode`，默认 `list`）                                                                                          |
| 目录树         | `src/core/webview/ui/scm/file-tree.ts` 构建；单链目录折叠成 `src \ core \ webview` 一行（与原生 compact folders 一致）                                                                                                                                       |

### 2.3 原生 SCM 集成已移除

`jj-view.nativeScm.enabled` 开关删除，原生 Source Control 集成整体移除：

- 不再 `createSourceControl`，没有 SCM 输入框、resource group、gutter quick diff
- 删除**仅原生 SCM 使用**的 `scm/title`、`scm/change/title` 菜单与 `scmProvider =~ /^jj/` 的 3 个键位
- Changes webview 的分组/文件行菜单改用 `jvl/resourceGroup/context` 与 `jvl/resourceState/context`：它们由 `ScmResourceGroup` / `ScmResourceItem` 作为 `menuId` 交给 webview 的 `MenuRegistry` 解析（VS Code 会忽略未知菜单位置），与原生 SCM 的 `scm/*` 命名解耦，避免再被当作原生 SCM 误删
- **保留** `ScmModel`、`FileDecorationProvider` 与 Changes / Repositories 视图；描述输入缓存于内存草稿（`setDraft()` / `clearDraft()`，带 dirty 标记，刷新不覆盖）
- 仅原生 SCM 使用的 `jj-view.focusRepository`、`jj-view.focusDescriptionInput` 命令删除

### 2.4 Code Forge 集成已移除

`jj-view.codeForge.enabled` / `jj-view.codeForge.provider` 开关删除，GitHub / GitLab / Gerrit 集成整体移除（约 6.6k 行）：

- 删除 provider、auth、registry、service，以及评论（Comments）与 Gerrit 凭据/主机探测工具（`gerrit-credential-utils`、`gerrit-host-detection`、`fetch-utils`）
- 删除 `jj.codeForge*` 上下文键、`manageAuth` 与全部评论命令/菜单
- **保留手动上传**：`upload` / `uploadStack` 仍执行 `jj git push`，但不再回读远端状态、不再做 Gerrit stack 准备与 PR 同步

### 2.5 合并编辑器（冲突解决）已移除

- 删除 `JjMergeService`、`VsCodeMergeContentProvider`、`jj-view.openMergeEditor` 命令与 `jj-merge-output` scheme
- 冲突文件仍出现在 Changes 视图的冲突组，点击按普通差异打开；`jj-view.newMergeChange`（创建合并提交）不受影响

### 2.6 刷新机制

| 改动                                                                                                                  | 原因                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `DirectoryWatcher` 对 120ms 内完全相同的批次去重，日志加实例号 `(#N)`                                                 | Windows `ReadDirectoryChangesW` 会对一次写入上报两次                                                                                        |
| watcher 忽略规则按 `.gitignore` 逐层判定（root / 嵌套 / `.git/info/exclude` / global），进入目录前先剪枝              | 不再维护 `node_modules`/`dist` 之类的硬编码目录名单，规则唯一来源是 gitignore                                                               |
| 窗口激活只刷新**聚焦仓库**（`ChangeDetectionManager.isFocused`，由 `JjRepositoryManager.syncRepositoryFocus()` 维护） | 多仓库时窗口切回来会同时跑 N 个 `jj status`                                                                                                 |
| 切换聚焦仓库时立即刷新一次（`reason: focused repository`）                                                            | 非聚焦仓库不再随激活刷新，避免切过去看到旧数据                                                                                              |
| 自产 `op_heads` 抑制（`SELF_OP_SUPPRESS_MS = 1500`）                                                                  | jj 每条命令都会 auto-snapshot 并写 `op_heads`，否则一次编辑触发「立即 + deferred」两轮刷新                                                  |
| 仓库实例去重（扫描 vs 动态注册竞态）                                                                                  | 曾因同一 root 创建两个 `JjRepository`，导致双 watcher、所有刷新做两遍；现在扫描复用并发注册的实例、动态注册创建后再校验、对账按实例身份回收 |

| **非聚焦仓库只做轻量快照**（跳过 `(::@ & mutable())` 与 `children()` 查询，只保留 `jj status` + `jj log -r @`） | Changes 视图看不到非聚焦仓库；Repositories 只需要变更数/冲突数 |
| 非聚焦仓库不再触发 `LogView` 刷新（`LogViewController.refresh` 按 `repo.isFocused` 提前返回） | 多仓库时后台改动只更新徽标，不再重渲染不可见的日志视图 |
| Changes 视图只订阅**聚焦仓库**的快照，Repositories 订阅全部 | 减少反序列化与 postMessage 次数 |
| 非聚焦仓库事件 debounce 1500ms（聚焦为配置的 100ms） | 保存/构建产生的连续事件合并为一次 |
| 窗口在后台时只有聚焦仓库响应 watcher 事件 | 后台构建不再让所有仓库各自跑一轮 `jj status`/`log` |
| Repos 标题栏 refresh 改为 `jj-view.refreshAll`：`repositoryManager.clear()` + 重新扫描 + 逐仓库 `forceSnapshot` 并补建缺失的 `VsCodeScmProvider` | 重装后 provider 未创建或快照为空时，单仓库 refresh 修不回来 |
| Changes 标题栏 refresh 仍只刷新选定仓库，但补上 `forceSnapshot`；`ready` 时若快照为空则主动强制刷新一次 | 面板重建后可能先拿到空快照，等文件事件才恢复 |
| 父仓库 watcher 忽略嵌套仓库的 `.jj` / `.git`（相对 glob + 事件兜底判定） | 子仓库每条 jj 命令都会写这些目录；父仓库无法跟踪它们，却会因此误刷新（如 `d:\py-code` 监听 `jj-view/.jj`） |
| `jj-view.refresh` 改为 `preserveFocus`：只刷新聚焦仓库，不再用活动编辑器解析 | 命令包装器原本无条件 `setFocusedRepository`，点 Changes 刷新会把聚焦切到「当前打开文件」所属的仓库 |

### 2.7 webview 自定义图标

`getWebviewHtml()` 现在内联 `media/custom-icons/jj-view-icons.css`（去掉原 `@font-face`），并追加指向 `jj-view-icons.woff2` 的 webview URI 字体声明。否则 `$(jj-icon-squash-into)` 这类自定义图标在 webview 中是空白。

---

### 2.8 本地优先（local-first）

三条保证：

1. 没有用户命令时**零网络请求**（激活、刷新、渲染、切换仓库都不联网）
2. 唯一的远端写入口是 `Upload` / `Upload Stack`（`jj git push`）
3. 远端状态读取入口已整体移除（Code Forge 见 2.4，无残留开关）

为此做了：

- `package.json` 的 `configurationDefaults` 关闭 VS Code 内置 Git 扩展的自动行为：`git.autofetch=false`（真正的联网）、`git.autorefresh=false`（与 jj 重复的本地 `git status`）
- Code Forge 已移除（见 2.4）：不再注册 provider、轮询/认证/状态刷新全部不存在
- 5s 文件轮询默认不启动（`watch` 模式；watcher 启动失败才回退 `polling`）
- `git config --get core.excludesFile` 与 `watchman` 探测改为**进程级缓存**，避免每个仓库重复 spawn
- 新增 `tooling/lint-local-only.ts`（挂在 `pnpm lint`）：扫描 `src/core` + `src/vscode`，除 upload 命令与终端命令检测外，禁止出现 `git push/fetch/clone`

| 仍会联网的操作        | 触发方式         |
| --------------------- | ---------------- |
| Upload / Upload Stack | 用户显式执行命令 |
| 帮助/文档链接         | 用户点击         |

### 2.9 行级 blame（current line blame）

点击/移动光标到某一行时，在该行末尾用灰色斜体显示「最后一次改动该行的提交」：`作者 · 相对时间 · 提交摘要`（如 `py · 1 day ago · feat: …`，超长截断），行为对齐 GitLens 的 current line blame。悬停整行（含行尾的 blame 文本区域）用 Markdown 气泡显示：`作者 · 相对时间` → 行级 diff 代码块 → 完整提交描述（不显示邮箱与 commit id）。

时间口径与 `jj log` 一致：取 **committer** 时间（`jj describe` 等改写只更新 committer，author 不变），annotate 模板输出 epoch 秒，界面在**渲染时**计算相对时间；60s 定时重渲染可见行，标签不会停在缓存时的那一刻。

#### 渲染与触发

- 数据来源：`jj file annotate -r @ -T '…'`，模板使用 `commit.commit_id()` / `commit.author().name()` / `commit.description().first_line()`（annotate 模板的关键字是 `commit`，不是 `commit_id`）
- 触发：`onDidChangeTextEditorSelection`，仅单光标空选区；选区变化防抖 `delay`（150ms）；同一行内移动列不重启调度
- 编辑中不显示：文档变更时立即清掉装饰，`documentDelay`（400ms）后按**新的行尾**重算 —— 避免 blame 被画到行中途；主装饰 `rangeBehavior: ClosedClosed`，每次贴之前按 `document.lineAt(line).text.length` 重算 range，`expectedVersion` 不匹配则丢弃
- 窗口化注解：文件超过 **2001 行**时只注解光标 ±1000 行（`ANNOTATION_WINDOW_LINES`），模板用 `if(line_number >= from && line_number <= to, record, "")` 过滤；缓存 key 带窗口范围，窗口内移动复用。实测 1638 行文件：全量 219ms / 240KB / 1638 条 → 窗口 187ms / **1.6KB / 11 条**；jj 侧仍 blame 全文件，收益是输出体积与解析量不再随文件大小线性增长
- 缓存：注解按 `仓库根|文件|内容签名(mtime:size)[#窗口]`（未保存编辑不会失效），最多 64 个；`@` 的 commit id 单独缓存 1s；行级 diff 与提交详情按 commit 缓存
- 仓库忙避让：仅在**缓存未命中、真要调 jj** 时判断 `repo.activeRefresh` / `await jj.whenIdle()`（超时 300ms），忙则 400ms 后重试；缓存命中直接渲染

#### 悬停

- 由 `registerHoverProvider`（整行 range）统一应答，主装饰不再挂 `hoverMessage`：blame 是 `renderOptions.after` 渲染的伪元素，不在装饰 range 内，Monaco 不会为它派发 hover
- 首屏 tooltip 只用注解生成摘要（0 次 jj）；悬停时按需异步解析完整 markdown（`Promise.all` 并行取行级 diff + 完整描述；未提交行再加 `@-` 注解，父提交详情依赖父注解仍串行），最多等 800ms（`HOVER_WAIT_MS`），超时回退摘要；结果写回 `_hoverByUri` 复用
- 不显示 `_Resolving commit details…_` 之类占位文案：VS Code 不会重新渲染已经显示的 tooltip，占位会一直挂着直到鼠标移动

#### 行级 diff 的正确行号

- `jj diff -r <commit>` 的 hunk 使用「该提交时文件的行号」；后续提交在上方插入/删除行后，用当前行号查 hunk 会 miss；若该提交新增/重写了整个文件，hunk 覆盖全部行，则任何行号都会"命中"，结果是**别的行**的内容
- 解法（`src/core/blame/line-map.ts`）：`jj file show -r <commit>` 取提交版本全文（按 commit+path 缓存），与编辑器 buffer 文本用 `diff`（jsdiff `diffArrays`）建「buffer 行 → 提交行」映射，再 `pickLineChange()` 查 hunk；一律先映射，不保留"直接查"快路径。用 buffer 文本映射，未保存的编辑也正确；映射不到（该行被改写）则不显示 diff
- `pickLineChange()` 的删除行只与**同一连续块**内的新增行配对（遇到上下文行清空 pending），避免 `-` 侧取到别处内容
- **行尾符归一**：`jj file show` 给的是 blob 原样（常见 LF），而工作区被 `core.autocrlf` 转成 CRLF；直接比较会让每行都"被改写"，映射为空 → hover 没有 diff（paim 实测 52 行全失配）。`buildBufferToCommitLineMap` 先 `stripCarriageReturn` 再 `diffArrays`，覆盖 LF / CRLF / 混合 / 无结尾换行

#### 未提交行

- 行末显示 `Uncommitted`；悬停与已提交行同一套段落顺序：`@-` 的 `作者 · 时间 · [Line History](…)` → `> ⚠️ **Uncommitted changes**` → 该行在 `@` 的行级 diff → `---` → `@-` 的完整描述
- 纯新增行没有可用的 `@-` 作者，首行为 `[Line History](…)`（仅链接），其后仍是 Notice → diff
- 未提交行的 Line History 从 `@-` 开始，展示已提交部分的历史；纯新增行打开后按现有逻辑提示无历史

#### 行历史（Line History）

- 入口：hover 标题行尾的 `Line History` 链接（`command:jj-view.lineHistory?{root,path,line}`），以及行号右键 `Show Line History`
- 展示：编辑区新增 **Line History 面板**（`vscode.createWebviewPanel`，每个窗口复用同一个 tab，再次触发仅 `reveal` + 重推数据）；标题 `Line History: <file>:<line>`
- 数据：`git log -L <line>,<line>:<path> --format=%H%x00%an%x00%aI%x00%s -n 200 <commit>`；提交 id 就是 jj 的 `commit_id`，点击条目打开该提交与父提交的 diff（`parents(<sha>)`，`preserveFocus`，面板不关闭）
- 不用 jj 自实现：`jj` 无 `git log -L` 等价物；逐提交 `jj diff` 走查实测 37s（105 步），同仓库 `git log -L` 带 patch 115ms（21 提交）。`jj log -p` 批量仍需自己实现行追踪
- 仓库形态：colocated 用 `<root>/.git`；非 colocated 用 `.jj/repo/store/git` + 显式 commit sha（不依赖 `HEAD`）
- 分页：一次取最多 200 条并在 host 端一次性下发（~24KB），面板先渲染 10 条，`Load more` 在 **webview 内本地追加**，列表容器不变、滚动位置不重置
- 条目：第一行 `短 sha + 摘要`，第二行显示**该提交下这一行的内容**（截断 100 字符），第三行 `作者 · 日期`；内容从同一次 `git log -L` 的 patch 里解析（`extractLineTexts`），无额外进程
- 限制：`git log -L` 不跟随重命名（重命名处停止）；仅单行；无 git 的仓库提示 “requires a git-backed repository”

#### 限制与配置

- 仅 `file` scheme、仓库内文件；超过 `maxFileLines`（5000）不注解；未跟踪/二进制文件静默不显示
- `jj-view.lineBlame.enabled`（`true`）、`delay`（150）、`documentDelay`（400）、`maxFileLines`（5000）、`showHover`（`true`）、`showLineDiff`（`true`）

#### 结构与测试

- `src/core/blame/line-blame.ts`：解析 / 格式化 / 缓存键 / `pickLineChange`（纯逻辑，可单测）
- `src/core/blame/line-map.ts`：buffer 行 → 提交行映射（`buildBufferToCommitLineMap`）
- `src/vscode/providers/vscode-line-blame-provider.ts`：渲染、调度、缓存、HoverProvider、诊断日志
- 诊断日志：`[LineBlame] update <file> | wcId=… | annotate(cached)=… | total=…`、`[LineBlame] hover resolved in …ms`、`[LineBlame] repository busy, deferring update (…)`
- 单测：注解解析、hover markdown（含 diff 段）、`pickLineChange` 配对、`line-map` 插入/删除/改写/追加/空文件
- e2e（`src/test/e2e/line-blame.spec.ts`，11 个）：首次悬停即完整内容（无占位）、光标行 tooltip、行尾语义触发（`editor.action.showHover`，不用像素坐标）、上方插入后仍显示本行 diff、整文件新增的提交不错行、编辑时 blame 不夹在行中间，以及 5 种行尾组合（LF / CRLF / 混合 / 无结尾换行 / CRLF 无结尾换行）都必须显示 diff
- 绝对时间用固定格式 `YYYY/MM/DD HH:mm:ss`（本地时区、补零，解析失败回退原串）：`toLocaleString()` 在 webview(Chromium/en-US) 与 Node(zh-CN) 输出不同，曾导致 tooltip 断言长期失败、切换显示语言时文案变化

### 2.10 JJ Log：显示范围与条数

revset（用户自定义 `revsets.log` 时优先用用户的）：

```text
mutable() | ancestors(parents(roots(mutable())), REMOTE)
```

| 部分                                           | 含义                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mutable()`                                    | 全部本地可变提交：@ 的祖先、@ 之上的提交、侧分支。原先用 `ancestors(@, N)`，进入旧提交后上方工作与侧分支全部消失（e2e 报 `Failed to find log row matching "side branch commit"`） |
| `ancestors(parents(roots(mutable())), REMOTE)` | `roots(mutable())` 是本地最早的提交，其父是紧贴本地的远端提交；往下取 REMOTE 条。窗口贴本地工作，不再把视口让给与本地无关的远端历史                                               |

- `jj-view.remoteLogDepth`（默认 10）：上面那个 REMOTE，`0` = 不显示远端
- 不显示：非本地的远端分叉、旧 tag 线；本地落后远端时看不到远端新增提交（设计如此）
- `jj-view.logLimit`（默认 200，`0` = 不限）：revset 无法按总数截断，条数由 `jj log -n` 控制；`jj-view.localLogDepth` 已删除（`mutable()` 无深度语义）

### 2.11 Chip 设计

四类 chip + 状态 chip 的完整规则见根目录 `design.md`，要点：

| chip          | 颜色   | 条件                                                                                           |
| ------------- | ------ | ---------------------------------------------------------------------------------------------- |
| 本地 bookmark | blue   | `bookmark.remote` 为空                                                                         |
| 远端 bookmark | purple | `bookmark.remote` 非空；**已跟踪**的远端 bookmark 会被 jj 折叠进本地项，只有未跟踪的才独立显示 |
| tag           | green  | `tags[]` 每项                                                                                  |
| 工作副本      | yellow | `working_copies[]` 每项（`name@`）                                                             |

Commit Details 的状态 chip 顺序：Immutable → Empty → Conflicted → bookmarks → tags。

---

## 3. 配置项

| 设置                                   | 默认    | 说明                                                    |
| -------------------------------------- | ------- | ------------------------------------------------------- |
| `jj-view.fileWatcherMode`              | `watch` | 事件驱动；watcher 启动失败自动回退 `polling`（5s/仓库） |
| `jj-view.refreshDebounceMillis`        | `100`   | 文件事件防抖                                            |
| `jj-view.refreshDebounceMaxMultiplier` | `4`     | 持续事件时的最大放大倍数                                |
| `jj-view.maxMutableAncestors`          | `10`    | 快照里抓取的祖先数量，影响单次刷新耗时                  |
| `jj-view.autoRepositoryDetection`      | `true`  | 设为 `subFolders` / `openEditors` 可减少被监控仓库数    |
| `jj-view.binaryPath`                   | `""`    | jj 可执行文件绝对路径                                   |
| `jj-view.remoteLogDepth`               | `10`    | JJ Log 在本地提交下方显示的远端提交数，`0` = 不显示     |
| `jj-view.logLimit`                     | `200`   | JJ Log 总行数上限（`jj log -n`），`0` = 不限            |
| `jj-view.lineBlame.enabled`            | `true`  | 行级 blame 开关                                         |
| `jj-view.lineBlame.delay`              | `150`   | 光标移动后注解的防抖（ms）                              |
| `jj-view.lineBlame.documentDelay`      | `400`   | 文档变更后重新注解的防抖（ms）                          |
| `jj-view.lineBlame.maxFileLines`       | `5000`  | 超过则不注解                                            |
| `jj-view.lineBlame.showHover`          | `true`  | 是否注册行级 hover tooltip                              |
| `jj-view.lineBlame.showLineDiff`       | `true`  | tooltip 是否包含行级 diff                               |

---

## 4. 代码地图

### 新增

| 文件                                                                  | 职责                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/vscode/providers/vscode-changes-webview-provider.ts`             | `repos` / `changes` 双模式 provider：聚合各仓库 `ScmModel` 快照、消息路由、用 `createJjResourceState()` 重建命令参数；`draft` → `setDraft()`，提交/设置描述后 `clearDraft()`；`jj-view.revealChangesGroup` 通过一次性 `revealChangeId` 让 webview 展开新组 |
| `src/core/blame/line-map.ts`                                          | 提交版本全文与编辑器 buffer 的行号映射（先 `stripCarriageReturn`，再 `diffArrays`），供行级 blame 的 diff 定位                                                                                                                                             |
| `src/vscode/register-commands.ts` 的 `registerViewCommandWithPayload` | 视图级命令包装：按**聚焦仓库**解析仓库并用该仓库的草稿做 payload，`jj-view.commit` / `commitPrompt` / `setDescription` 用它                                                                                                                                |
| `design.md`                                                           | chip 类型、渲染条件、顺序与配色规则                                                                                                                                                                                                                        |
| `src/core/webview/changes/index.ts`                                   | webview 入口（`initBridge` + `mount`）                                                                                                                                                                                                                     |
| `src/core/webview/changes/ChangesApp.svelte`                          | 按 `mode` 渲染仓库列表或聚焦仓库的 `ScmPane`，含自绘右键菜单                                                                                                                                                                                               |
| `src/core/webview/ui/scm/file-tree.ts`                                | 扁平变更列表 → 目录树（含单链折叠）                                                                                                                                                                                                                        |
| `src/core/webview/ui/scm/ScmTreeItem.svelte`                          | 目录树递归渲染                                                                                                                                                                                                                                             |
| `media/jj-view-container.svg`                                         | 活动栏容器图标（24×24 单色）                                                                                                                                                                                                                               |

### 主要修改

| 文件                             | 改动                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/webview/ui/scm/ScmPane.svelte`     | 新增 `showHeader` / `compactInput` / `viewMode` / `expandAncestors` / `onDescriptionChange` / `revealedChangeId`，默认值保持原行为        |
| `src/core/webview/ui/scm/ScmInputBox.svelte` | `compact` 模式（单行自适应、不拦截 Ctrl+Enter）；**只有真实 input 事件**才 `onValueChange`，挂载/属性同步只重算高度（否则空值会覆盖草稿） |

| `src/core/webview/ui/scm/ScmResourceGroup.svelte` / `ScmResourceItem.svelte` | tree/list 切换、隐藏目录后缀；组头 `data-change-id` + `expanded` 变 true 时强制展开（不反向折叠） |
| `src/vscode/vscode-webview-html.ts` | 内联自定义图标字体 |
| `src/vscode/providers/vscode-scm-provider.ts` | 支持跳过原生 SCM；草稿 `setDraft()` / `clearDraft()` + dirty 标记，`renderSnapshot` 不覆盖脏草稿 |
| `src/core/code-forge-service.ts` | `enabled` 开关与各入口短路 |
| `src/core/change-detection-manager.ts` | 聚焦刷新、自产 op_heads 抑制、gitignore 逐层剪枝、实例化参数 |
| `src/core/directory-watcher.ts` | 事件去重 + 实例号日志 |
| `src/core/jj-repository.ts` / `jj-repository-manager.ts` | 焦点标志、仓库实例去重与回收 |
| `esbuild.js` / `package.json` | 单平台构建、Changes webview 入口、视图与菜单、新配置项 |
| `src/vscode/extension.ts` | 注册两个容器 provider、条件注册 code forge provider、配置变更提示 |

### 数据流

```flow
repositoryManager (扫描/聚焦)
   └─ JjRepository → ScmModel (jj status/log 快照)
        ├─ VsCodeScmProvider        → 原生 SCM（可关闭）
        └─ VsCodeChangesWebviewProvider → webview（repos / changes）
                                              └─ postMessage: executeCommand / focusRepository / draft / open / action
```

消息协议只传纯数据（`root` / `path` / `revision` / `status` / `contextValue`），不序列化 `Uri`；扩展侧用 `createJjResourceState()` 重建。

---

## 5. 开发与验证

```powershell
pnpm install
pnpm build              # 主题 + 图标 + 类型 + lint + esbuild
```

- 调试：F5（`watch` 任务并行跑 esbuild / tsc / themes）
- 打包安装：`pnpm package --out jj-view.vsix` → `code --install-extension jj-view.vsix --force`
- 产物：53 files / 约 1.99 MB

### 测试

| 层级           | 命令                            | 覆盖                                                        |
| -------------- | ------------------------------- | ----------------------------------------------------------- |
| 静态检查       | `pnpm lint`、`pnpm check-types` | biome + core isolation + fsPath + local-only；两套 tsconfig |
| 单元测试（快） | `pnpm test:unit`                | 纯逻辑 / 纯 mock，约 735 个用例，4–5 秒                     |
| 仓库级测试     | `pnpm test:repo`                | `*.repo.test.ts`：真实 `jj`/`git` 工作副本，分钟级          |
| 按变更执行     | `pnpm test:changed`             | 以 git HEAD 为基线，只跑受影响文件                          |
| 激活测试       | `pnpm test:activation`          | 真实 VS Code 激活 + 命令注册                                |
| 容器 e2e       | `pnpm test:e2e changes-view`    | Changes 渲染/树切换、Repositories 徽标                      |

单测分层约定：`*.test.ts` 必须是纯逻辑（不建仓库、不启子进程）；需要真实 jj 仓库的用 `*.repo.test.ts`，需要真实 VS Code 的用 `*.integration.test.ts`。

e2e 注意事项：

- `src/test/e2e/vscode-fixture.ts` 的路径比较已做 Windows 归一化（VS Code 返回小写盘符 `c:\`），否则所有用例 15s 超时
- `DEFAULT_SETTINGS` 不再注入已删除的 `nativeScm.enabled` / `codeForge.enabled`；依赖原生 SCM 与 GitHub/GitLab/Gerrit 的 e2e 已随之删除
- 多项目用例用 `openWorkspace({ path: parent, waitForRepository: false }, { 'jj-view.autoRepositoryDetection': true })`：根目录不是仓库，fixture 改为等"任意仓库被发现"；单目录用例行为不变
- 测试宿主版本固定在 `tooling/vscode-version.json`（当前 `1.145.0`），e2e 与 integration 共用；`JVL_VSCODE_VERSION` 可临时覆盖。不固定时会解析 `stable`，每次运行都可能换版本并访问更新 API
- fixture 校验 `jj-view.*` 设置是否注册时，按**扩展贡献的配置项**查找（扩展 ID 曾从 `jj-view` 改为 `jj-view-local`，按 ID 查找会把合法设置判成非法）
- 现有 e2e 套件：`changes-view`（8）、`jj-log`（17）、`multi-repo`（2）、`line-blame`（11）、`squash`（5）、`arbitrary-diff` / `commit-details` / `context-menu` / `divergent` / `hidden-commits` / `view-file` / `workspace`
- 不跑 integration 的场景：日常改动以 `test:unit` + 相关 e2e 为准；integration 只在提交前/CI 跑（启动真实 VS Code 宿主，分钟级）

---

## 6. 已知限制 / 后续

- 未清理 `.vscodeignore` / `.gitignore` / `.biomeignore` 中已删除路径的条目（无害）
- 多选批量操作（等价 `TreeView.selection`）未实现
- gutter quick diff 随原生 SCM 集成一并移除，不可再用
- 冲突解决（三方合并编辑器）已移除，冲突文件只能按普通差异查看/手工编辑
- 点击 Changes 中的 commit 定位 JJ Log 的联动（原 P3）未做
- JJ Log 只显示本地上下文：非本地的远端分叉、旧 tag 线不渲染；本地落后远端时看不到远端新增提交（`remoteLogDepth` 只作用于本地最早提交下方的窗口）
- 聚焦仓库**不跟随**活动编辑器（多项目下浏览别的项目不会切走视图）；切仓只能点击 Repositories 行，或 `new` / `edit` 类命令
- 拆分为新提交只支持**单个文件**（`path`，非 `paths`）；多文件拆分未做

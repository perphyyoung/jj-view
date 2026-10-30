# py-changes.md

> py 的改动记录：这个 fork 相对上游 `jj-view` 做了哪些**功能变更**、为什么这样做、以及**怎么开发/验证**。
> 最后更新：2026-10-29

---

## 0. 定位

| 维度    | 选择                                                                               |
| ------- | ---------------------------------------------------------------------------------- |
| 平台    | 只支持 **Windows 11 x64**，不再产出跨平台包                                        |
| 网络    | **完全本地化**：不读取远端状态（PR/MR、CI、评论），仅保留手动上传（`jj git push`） |
| UI 入口 | 活动栏 **JJ View** 容器（Repositories / Changes / JJ Log），原生 SCM 默认不注册    |
| 发布    | 仅本地 VSIX，不上传 Marketplace / OpenVSX                                          |

核心思路：**扩展命令层与数据层不变，新增一个活动栏容器作为主要 UI，原生 SCM 与 Code Forge 降级为可选开关。**

---

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

保留 `web/src/scm/**` 与 `web/src/menu/**` —— 它们是 VS Code webview 复用的组件库（Changes 视图直接使用）。`package.json` 同时移除了 `build:web*`、`build:server*`、`build:all`、`dev*`、`setup:sidecar`、`test:e2e:web`。

---

## 2. 功能变更

### 2.1 独立容器：Repositories / Changes / JJ Log

`jj-view-container`（Activity Bar）下三个视图：

| 视图         | id                    | 内容                                                                  |
| ------------ | --------------------- | --------------------------------------------------------------------- |
| Repositories | `jj-view.reposView`   | 每个仓库/工作区一行，常驻显示冲突数（黄）/ 变更数徽标，当前聚焦项高亮 |
| Changes      | `jj-view.changesView` | 只显示**聚焦仓库**的提交输入框与变更分组，标题为 `Changes (repo)`     |
| JJ Log       | `jj-view.logView`     | 已有提交图                                                            |

- 点击 Repositories 中的一行 → `setFocusedRepository` → Changes 自动切换
- 两个 webview 共用一个 bundle `dist/webview/changes.js`，由 `init` 消息里的 `mode`（`repos` / `changes`）决定渲染内容
- 视图标题栏动作：Changes 有 Commit（✓）/ Refresh / New / Add Workspace；Repositories 有 Add Workspace / Refresh

### 2.2 Changes 视图细节

| 行为           | 实现                                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 只显示当前仓库 | provider 只推送 `focusedRoot` 的快照；切换仓库由 `onDidChangeFocusedRepository` 驱动                                                                                                                                              |
| 分组           | Merge Conflicts / Working Copy / ancestors；**ancestors 默认折叠**（`ScmPane` 的 `expandAncestors=false`）                                                                                                                        |
| 写操作         | 资源级走 `state.command`（`vscode.diff` / `vscode.open` / `jj-view.openMergeEditor`）；分组级重建 `{ id, rootUri, ancestor, resourceStates }` 后调用既有命令（absorb / squash / abandon / show details / edit / multi-file diff） |
| 右键菜单       | 复用 web 侧 `MenuRegistry` + `WhenEvaluator` + `ContextMenu.svelte`，菜单数据由扩展在 `init` 时注入真实 `package.json` contributes                                                                                                |
| 提交输入框     | 单行（约 26px）按行增高，240px 后内部滚动；不拦截 Ctrl+Enter；只有标题栏 ✓ 提交                                                                                                                                                   |
| 提交链路       | 输入内容通过 `draft` 消息写入 `setInputBoxValue()`（无 SCM 时缓存到 `_inputBoxFallback`），`jj-view.commit` 读到的就是新视图里的文字                                                                                              |
| View as Tree   | 命令 `jj-view.changesAsTree` / `jj-view.changesAsList`，按上下文键 `jj.changesViewAsTree` 互斥显示，模式存 `globalState`（`jj-view.changesViewMode`，默认 `list`）                                                                |
| 目录树         | `web/src/scm/file-tree.ts` 构建；单链目录折叠成 `src \ core \ webview` 一行（与原生 compact folders 一致）                                                                                                                        |

### 2.3 原生 SCM 开关（默认关闭）

`jj-view.nativeScm.enabled`（默认 `false`）：关闭时 `VsCodeScmProvider` 跳过 `createSourceControl`、resource group、`inputBox`、`quickDiffProvider`，但**保留** `ScmModel` 与 `FileDecorationProvider`，因此 Changes / Repositories / 文件装饰不受影响。

- 关闭后失去：gutter quick diff、SCM 输入框、`scm/*` 菜单、`scmProvider =~ /^jj/` 的 3 个键位
- 修改该设置后提示 Reload Window（provider 按仓库在激活时创建）

### 2.4 Code Forge 本地化（默认关闭）

`jj-view.codeForge.enabled`（默认 `false`）：

- 不注册 GitHub/GitLab/Gerrit provider 工厂，`CodeForgeService` 构造时直接返回
- `detectActiveProvider` / `startPolling` / `forceRefresh` / `requestRefreshWithBackoffs` 全部短路 → 不读 `git remote`、不请求 `api.github.com`、不触发 GitHub 认证
- `jj.codeForgeAuthManageable` 恒为 false，Manage Auth 按钮隐藏
- **保留手动上传**：`upload` / `uploadStack` / `advanceBookmarkAndUpload` 仍执行 `jj git push`，只是推送后不再刷新远端状态

### 2.5 刷新机制

| 改动                                                                                                                  | 原因                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `DirectoryWatcher` 对 120ms 内完全相同的批次去重，日志加实例号 `(#N)`                                                 | Windows `ReadDirectoryChangesW` 会对一次写入上报两次                                                                                        |
| watcher 忽略规则按 `.gitignore` 逐层判定（root / 嵌套 / `.git/info/exclude` / global），进入目录前先剪枝              | 不再维护 `node_modules`/`dist` 之类的硬编码目录名单，规则唯一来源是 gitignore                                                               |
| 窗口激活只刷新**聚焦仓库**（`ChangeDetectionManager.isFocused`，由 `JjRepositoryManager.syncRepositoryFocus()` 维护） | 多仓库时窗口切回来会同时跑 N 个 `jj status`                                                                                                 |
| 切换聚焦仓库时立即刷新一次（`reason: focused repository`）                                                            | 非聚焦仓库不再随激活刷新，避免切过去看到旧数据                                                                                              |
| 自产 `op_heads` 抑制（`SELF_OP_SUPPRESS_MS = 1500`）                                                                  | jj 每条命令都会 auto-snapshot 并写 `op_heads`，否则一次编辑触发「立即 + deferred」两轮刷新                                                  |
| 仓库实例去重（扫描 vs 动态注册竞态）                                                                                  | 曾因同一 root 创建两个 `JjRepository`，导致双 watcher、所有刷新做两遍；现在扫描复用并发注册的实例、动态注册创建后再校验、对账按实例身份回收 |

### 2.6 webview 自定义图标

`getWebviewHtml()` 现在内联 `media/custom-icons/jj-view-icons.css`（去掉原 `@font-face`），并追加指向 `jj-view-icons.woff2` 的 webview URI 字体声明。否则 `$(jj-icon-squash-into)` 这类自定义图标在 webview 中是空白。

---

## 3. 配置项

| 设置                                   | 默认    | 说明                                                    |
| -------------------------------------- | ------- | ------------------------------------------------------- |
| `jj-view.nativeScm.enabled`            | `false` | 是否注册到原生 SCM 视图                                 |
| `jj-view.codeForge.enabled`            | `false` | 是否读取远端 PR/CI/评论                                 |
| `jj-view.fileWatcherMode`              | `watch` | 事件驱动；watcher 启动失败自动回退 `polling`（5s/仓库） |
| `jj-view.refreshDebounceMillis`        | `100`   | 文件事件防抖                                            |
| `jj-view.refreshDebounceMaxMultiplier` | `4`     | 持续事件时的最大放大倍数                                |
| `jj-view.maxMutableAncestors`          | `10`    | 快照里抓取的祖先数量，影响单次刷新耗时                  |
| `jj-view.autoRepositoryDetection`      | `true`  | 设为 `subFolders` / `openEditors` 可减少被监控仓库数    |
| `jj-view.binaryPath`                   | `""`    | jj 可执行文件绝对路径                                   |

---

## 4. 代码地图

### 新增

| 文件                                                      | 职责                                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/vscode/providers/vscode-changes-webview-provider.ts` | `repos` / `changes` 双模式 provider：聚合各仓库 `ScmModel` 快照、消息路由、用 `createJjResourceState()` 重建命令参数 |
| `src/core/webview/changes/index.ts`                       | webview 入口（`initBridge` + `mount`）                                                                               |
| `src/core/webview/changes/ChangesApp.svelte`              | 按 `mode` 渲染仓库列表或聚焦仓库的 `ScmPane`，含自绘右键菜单                                                         |
| `web/src/scm/file-tree.ts`                                | 扁平变更列表 → 目录树（含单链折叠）                                                                                  |
| `web/src/scm/ScmTreeItem.svelte`                          | 目录树递归渲染                                                                                                       |
| `media/jj-view-container.svg`                             | 活动栏容器图标（24×24 单色）                                                                                         |

### 主要修改

| 文件                                                             | 改动                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `web/src/scm/ScmPane.svelte`                                     | 新增 `showHeader` / `compactInput` / `viewMode` / `expandAncestors` / `onDescriptionChange`，默认值保持原行为 |
| `web/src/scm/ScmInputBox.svelte`                                 | 新增 `compact` 模式（单行自适应、不拦截 Ctrl+Enter）                                                          |
| `web/src/scm/ScmResourceGroup.svelte` / `ScmResourceItem.svelte` | tree/list 切换、隐藏目录后缀                                                                                  |
| `src/vscode/vscode-webview-html.ts`                              | 内联自定义图标字体                                                                                            |
| `src/vscode/providers/vscode-scm-provider.ts`                    | 支持跳过原生 SCM、`setInputBoxValue()` 回退                                                                   |
| `src/core/code-forge-service.ts`                                 | `enabled` 开关与各入口短路                                                                                    |
| `src/core/change-detection-manager.ts`                           | 聚焦刷新、自产 op_heads 抑制、gitignore 逐层剪枝、实例化参数                                                  |
| `src/core/directory-watcher.ts`                                  | 事件去重 + 实例号日志                                                                                         |
| `src/core/jj-repository.ts` / `jj-repository-manager.ts`         | 焦点标志、仓库实例去重与回收                                                                                  |
| `esbuild.js` / `package.json`                                    | 单平台构建、Changes webview 入口、视图与菜单、新配置项                                                        |
| `src/vscode/extension.ts`                                        | 注册两个容器 provider、条件注册 code forge provider、配置变更提示                                             |

### 数据流

```
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

| 类型            | 命令                                                                         | 覆盖                                                                             |
| --------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 静态检查        | `pnpm lint`、`pnpm check-types`                                              | biome + core isolation + fsPath 断言；两套 tsconfig                              |
| 组件单测        | `pnpm exec vitest run web/test/scm-pane.test.ts web/test/file-tree.test.ts`  | 16 个用例（SCM 渲染、树构建）                                                    |
| 刷新单测        | `pnpm exec vitest run src/test/change-detection-manager.test.ts`             | 23 个用例（watch/polling、deferred、自产 op 抑制、失败回退）                     |
| Code Forge 单测 | `pnpm exec vitest run src/test/code-forge-service.test.ts`                   | 14 个用例（含“禁用后不建 provider、不读 remote、不轮询”）                        |
| 激活测试        | `pnpm test:activation`                                                       | 真实 VS Code 激活 + 命令注册                                                     |
| 容器 e2e        | `pnpm exec playwright test -c playwright.e2e.config.ts changes-view.spec.ts` | 4 个用例：Changes 渲染/树切换、原生 SCM 关闭、Code Forge 关闭、Repositories 徽标 |

e2e 注意事项：

- `src/test/e2e/vscode-fixture.ts` 的路径比较已做 Windows 归一化（VS Code 返回小写盘符 `c:\`），否则所有用例 15s 超时
- `DEFAULT_SETTINGS` 中显式开启 `nativeScm.enabled` 与 `codeForge.enabled`，避免既有 SCM / GitHub / GitLab / Gerrit 用例因新默认值失效；容器相关用例按需覆盖为 `false`

---

## 6. 已知限制 / 后续

- 未清理 `.vscodeignore` / `.gitignore` / `.biomeignore` 中已删除路径的条目（无害）
- 多选批量操作（等价 `TreeView.selection`）未实现
- gutter quick diff 依赖原生 SCM，关闭后不可用
- Code Forge 轮询实际是 60s 定时器 + 失败退避；本地化后默认不启动，未再调整
- 点击 Changes 中的 commit 定位 JJ Log 的联动（原 P3）未做

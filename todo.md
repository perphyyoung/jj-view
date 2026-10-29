# JJ View 独立容器改造进度

## 目标

在 `jj-view` 活动栏容器中提供**完整的 jj 操作能力**（读 + 写），不依赖内置「源代码管理」容器，并支持多仓库 / 多工作区。

## 约束与设计决策

- 现有 `VsCodeScmProvider`（原生 SCM 树）**保持不动**，SCM 容器里的 `Jujutsu (repo)` 继续工作。
- 新容器 = 第二个前端：数据复用 `repositoryManager` + `scmProviders.get(root).scmModel`，写操作复用已注册的 `jj-view.*` 命令。
- **视图拆分（与原生 SCM 对齐）**：`jj-view-container` 下三个视图
  1. `Repositories`（`jj-view.reposView`）：每个仓库/工作区一行，常驻显示变更数 / 冲突数徽标；
  2. `Changes`（`jj-view.changesView`）：只显示**当前聚焦仓库**的提交输入框与变更分组，标题为 `Changes (repo)`；
  3. `JJ Log`（已有）。
  点击 Repositories 中的某一行 → `setFocusedRepository` → Changes 视图自动切换。
- 渲染方式：webview（复用 `web/src/scm/ScmPane.svelte` 等已有组件），同一个 `changes.js` bundle 通过 `mode`（`repos` / `changes`）渲染两种视图。
- 消息协议不传 URI 对象：webview 只传 `{ root, path, revision, status, contextValue }` 这类纯数据，扩展侧用 `createJjResourceState()` 重建 `JjResourceState`。
- 右键菜单复用 web 侧 `MenuRegistry` + `WhenEvaluator` + `ContextMenu.svelte`，菜单数据由扩展注入 `package.json` 的 `contributes`。

## 文件清单

| 文件 | 说明 |
|---|---|
| `src/vscode/providers/vscode-changes-webview-provider.ts` | 新增：`repos` / `changes` 双模式 provider，聚合快照 + 消息路由 + 命令参数重建 |
| `src/core/webview/changes/index.ts` | 新增：webview 入口（`initBridge` + `mount`） |
| `src/core/webview/changes/ChangesApp.svelte` | 新增：按 `mode` 渲染仓库列表或单个 `ScmPane` + 右键菜单 |
| `web/src/scm/ScmPane.svelte` | 修改：新增可选 `showHeader` / `compactInput` / `viewMode`（默认值保持 web 版行为） |
| `web/src/scm/file-tree.ts` | 新增：扁平变更列表 → 目录树 |
| `web/src/scm/ScmTreeItem.svelte` | 新增：目录树递归渲染（文件夹可折叠） |
| `esbuild.js` | 修改：webview 入口新增 `changes` |
| `package.json` | 修改：容器新增 `Repositories` / `Changes` 视图；`view/title` 分别配置动作 |
| `src/vscode/extension.ts` | 修改：注册两个 provider 实例（`repos` / `changes`） |

## 任务

### P0 骨架

- [x] `esbuild.js` 增加 webview 入口 `changes`
- [x] `src/core/webview/changes/index.ts` 挂载入口
- [x] `package.json`：`Repositories` + `Changes` 两个 webview 视图 + 各自标题栏菜单
- [x] provider 支持 `repos` / `changes` 双模式，两实例共享同一 bundle
- [x] `ChangesApp.svelte` 按模式渲染：仓库列表（含徽标）/ 聚焦仓库的 `ScmPane`
- [x] `web/src/scm/ScmPane.svelte` 增加 `showHeader` 可选属性
- [x] `src/vscode/extension.ts` 注册两个 provider

### P1 写操作

- [x] 资源级动作：restore / squash into parent/child / open / open merge editor
- [x] 分组级动作：absorb / squash revision / abandon / show details / edit / show multi-file diff
- [x] 描述与提交：`ScmInputBox` → `jj-view.setDescription`；提交前同步 `SourceControl.inputBox` 再执行 `jj-view.commit`
- [x] 刷新：每仓库 `scmModel.onDidChangeSnapshot` → 推送 `state`；`refresh` 消息按仓库刷新

### P2 菜单与交互

- [x] 注入真实 `contributes`，右键菜单走 `scm/resourceState/context` / `scm/resourceGroup/context` 的同一套 `when` 条件
- [x] 菜单 payload 解包：`resourceState` / `scmResourceGroupId` → 扩展侧动作
- [x] quick input / 通知：命令在扩展宿主执行，复用 VS Code 原生输入框与错误提示

### 变更列表视图模式（View as Tree / List）

- [x] 命令 `jj-view.changesAsTree`（View as Tree）/ `jj-view.changesAsList`（View as List），放在 Changes 视图标题栏 `...` 菜单 + 命令面板，按上下文键 `jj.changesViewAsTree` 互斥显示
- [x] 模式持久化到 `globalState`（`jj-view.changesViewMode`），默认 `list`
- [x] `buildFileTree()`：按目录聚合、文件夹优先、同级按名称排序
- [x] 单链目录折叠成一行（`src \ core \ webview`），与原生 compact folders 一致
- [x] `ScmTreeItem.svelte` 递归渲染目录，文件夹可折叠；文件行不再显示目录后缀
- [x] 缩进从分组下一级开始（顶层文件夹 chevron 18px），文件行与所属文件夹图标对齐
- [x] `ScmResourceGroup` 按 `viewMode` 在 tree / list 之间切换，`ScmPane` / `ChangesApp` 透传
- [x] Changes 视图默认只展开 Working Copy / Merge Conflicts，`@-1` 及更早的 ancestor 分组默认折叠（`ScmPane` 新增 `expandAncestors`，Changes 视图传 `false`；web 独立版默认仍为 `true`）

### 提交输入框（Changes 视图）

- [x] 默认单行（`rows={1}`，`compact` 模式，min-height 归零）
- [x] 回车正常换行，按行增高：单行约 26px（对齐原生 SCM 输入框），达到 240px 后内部滚动
- [x] 移除输入框内的 Ctrl+Enter 提交快捷键（`compact` 下不拦截按键）
- [x] 只保留视图标题栏的对号提交：`view/title` 由 `jj-view.commitPrompt` 改为 `jj-view.commit`；输入内容通过 `draft` 消息实时同步到 `SourceControl.inputBox`，保证该命令提交的是新视图里输入的文字
- [x] `ScmInputBox` / `ScmPane` 通过可选 `compact` / `compactInput` 属性启用，web 独立版行为不变

### 修复记录

- [x] webview 未加载自定义图标字体，导致 `Squash File(s) into Ancestor` 等使用 `$(jj-icon-*)` 的按钮显示为空：`getWebviewHtml()` 现在内联 `media/custom-icons/jj-view-icons.css`（去掉原 `@font-face`）并追加指向 `jj-view-icons.woff2` 的 webview URI 字体声明

### 验证

- [x] `pnpm lint`（含 core isolation / fs-path 断言）
- [x] `pnpm check-types`
- [x] `node esbuild.js` 产出 `dist/webview/changes.js` / `changes.css`
- [x] `pnpm package` + `node tooling/verify-vsix.ts`（54 files / 1.99 MB）
- [x] 打包产物 `jj-view-container` 顺序：`jj-view.reposView` → `jj-view.changesView` → `jj-view.logView`
- [x] `pnpm exec vitest run web/test/scm-pane.test.ts web/test/file-tree.test.ts`（10 + 6 tests）
- [x] `pnpm test:activation`（3 passing，含双 provider 注册）

## 如何试用

1. `pnpm build`（或 F5 使用 watch 任务）
2. 活动栏 **JJ View**：
   - **Repositories**：每个仓库一行，右侧为冲突数（黄）/ 变更数徽标，当前聚焦仓库高亮
   - 点击某行 → **Changes** 视图切换为该仓库，标题变为 `Changes (repo)`
   - **Changes**：提交输入框 + Merge Conflicts / Working Copy / ancestors 分组
3. 操作：点击文件开 diff、hover 行内按钮、右键菜单（restore / squash / absorb / abandon / show details / edit / multi-file diff）；输入描述后 Ctrl+Enter 提交、Ctrl+S 保存描述

## 已知限制 / 后续

- gutter quick diff 仍由原生 SCM provider 提供；新视图不重复实现。
- `Changes` 视图与 `Repositories` 视图各自订阅快照，同仓库变更会各推一次 `state`（数据量小，暂不合并）。
- 多选批量操作（等价 `TreeView.selection`）暂未实现。
- 未新增 e2e 用例；后续可基于 `jj-repos-root` / `jj-changes-root` / `scm-pane` 的 testid 补 Playwright 断言。
- P3（点击 changes 中的 commit 定位 JJ Log）按约定暂不做。

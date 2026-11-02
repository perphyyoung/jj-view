# design.md

## Chip 设计规范

### 通用规范

- 基类 `BasePill`：圆角 11px、高 22px、min-width 22px、padding `0 6px`、gap 4px、图标 11px、单行省略
- 配色：accent 取 `--vscode-charts-*`；背景 `color-mix(accent, transparent 90%)`；边框 `color-mix(accent, transparent 50%)`
- hover 显示完整值（`title`）
- 值为空不渲染；过长省略
- 右键：`data-vscode-context` + `preventDefaultContextMenuItems: true`

### 标识 chip

| chip          | 出现条件                | 颜色   | 图标               | 文案          | 右键                                    |
| ------------- | ----------------------- | ------ | ------------------ | ------------- | --------------------------------------- |
| 本地 bookmark | `bookmark.remote` 为空  | blue   | `codicon-bookmark` | `name`        | `jj.bookmark`（isRemoteBookmark=false） |
| 远端 bookmark | `bookmark.remote` 非空  | purple | `codicon-bookmark` | `name@remote` | `jj.bookmark`（isRemoteBookmark=true）  |
| tag           | `tags[]` 每项           | green  | `codicon-tag`      | tag 名        | 默认菜单                                |
| 工作副本      | `working_copies[]` 每项 | yellow | 无                 | `name@`       | `workspace`（workspaceName）            |

- 已跟踪的远端 bookmark 不单独出 chip：jj 的 `bookmarks` 会把它折叠进本地项
- 未跟踪的远端 bookmark 才作为独立项出现（紫色）

### 状态 chip（Commit Details，顺序固定）

| chip       | 条件         | 文案         |
| ---------- | ------------ | ------------ |
| Immutable  | 提交不可改写 | `Immutable`  |
| Empty      | 无文件改动   | `Empty`      |
| Conflicted | 有未解决冲突 | `Conflicted` |

顺序：Immutable → Empty → Conflicted → bookmarks → tags。

### 非 chip 标记

| 位置           | 标记                                                                        |
| -------------- | --------------------------------------------------------------------------- |
| 日志描述       | 前缀 `(empty)`、`(divergent)`、`(no description)`                           |
| 日志行底色     | 冲突 red 10%/20%、divergent purple、选中 `list-inactiveSelectionBackground` |
| 拖拽           | `drop-badge`（修饰键 badgeText + accent 色）、落点虚线 bookmark 预览        |
| Changes 仓库行 | 冲突数 badge（warning 色）、改动数 badge                                    |
| Changes 文件行 | 状态字母 M/A/D/C（gitDecoration 配色）                                      |
| Changes 分组头 | 文件数 badge                                                                |

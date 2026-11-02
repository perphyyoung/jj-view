# todo

本文件仅供临时性的进度追踪，其它文件不得引用。

---

# 行级 blame：性能与 hover 命中区域

## 一、性能：完整 hover 太慢（实测 + 优化项）

本机实测（单次 jj 调用，`--ignore-working-copy`，511 行文件）：

| 步骤           | 命令                                  | 耗时         |
| -------------- | ------------------------------------- | ------------ |
| 取 @ commit id | `jj log -r @ -n 1`                    | 178 ms       |
| 全文件注解     | `jj file annotate -r @`               | 212 ms       |
| 父版本注解     | `jj file annotate -r @-`              | 219 ms       |
| 行级 diff      | `jj diff --git -r <commit> -- <file>` | 203 ms       |
| 完整描述       | `jj log -T description`               | 198 ms       |
| 纯 spawn 基线  | `jj --version`                        | 88 ms        |
| **串行合计**   |                                       | **≈1010 ms** |

叠加 300ms `hoverDelay` 后完整版 ≈1.3s；实测体感 >5s，来自下列额外阻塞：

1. `whenIdle` / `activeRefresh` 让路：仓库一忙就 `_schedule` 重试（400ms 延迟 + 最多 800ms 等待），一次让路 ≈1.2s；`ChangeDetectionManager` 在保存文件、窗口激活、**每 5s 轮询**时都会 `triggerRefresh({forceSnapshot:true})`。
2. `JjRepository.refresh` 里的 `clearCache()` 会清掉 `getLogEntry('@')` 的缓存 → 每次刷新后首次 hover 重新 `jj log @`（178ms）。
3. hover 的三次 jj 调用（diff → 父注解 → 描述）是**串行**的，可并行。
4. 未提交行还要多一次 `parentDetails`（+198ms）。

### 优化项（按收益排序）

- [x] **P0 并行化 hover 的三次调用**：`diff` 与 `parentAnnotate` / `details` 改 `Promise.all`（未提交行的 `parentDetails` 仍依赖父注解，保持串行）。
- [x] **P1 缓存命中时不再让路**：`activeRefresh` / `whenIdle` 判断移到"注解缓存未命中、真要发起 jj 调用"之前；缓存命中直接渲染。
- [x] **P2 `@` 的 commit id 单独缓存**：provider 内 `_workingCopy` 缓存，TTL `WORKING_COPY_TTL_MS = 1000ms`，不再受 `clearCache()` 影响。
- [x] **P3 `whenIdle` 超时 800ms → 300ms**（`DEFAULT_IDLE_TIMEOUT_MS`）；刷新期由 `repo.activeRefresh` 单独判断。
- [x] **P4 减少注解体积**（已实现，窗口化）：
  `annotateFile(file, rev, { from, to })` 用模板 `if(line_number >= from && line_number <= to, record, "")` 只输出窗口内的行；
  provider 对**超过 2001 行**的文件按光标位置取 ±1000 行的窗口，缓存 key 带上窗口范围，窗口内移动仍复用缓存。
  实测（1638 行文件）：全量 219ms / **240 KB / 1638 条**；窗口 100~110 → 187ms / **1.6 KB / 11 条**（范围精确）。
  jj 侧仍要 blame 全文件，所以**耗时基本不变**，收益是输出体积与解析量不再随文件大小线性增长；
  `lineBlame.maxFileLines`（5000 行）仍作为上限保护。
- [x] **P5 hover 进度提示**：第一段摘要 tooltip 末尾追加 `_Resolving commit details…_`，完整信息到手后替换；`showHover=false` 时不再注册 tooltip。

### 已加的诊断日志

```
[LineBlame] hover <file> | whenIdle=0ms | wcId=178ms | annotate(cached)=0ms | hoverDelay=300ms | diff=203ms | parentAnnotate=219ms | parentDetails=198ms | details=198ms | total=1296ms
[LineBlame] hover skipped: superseded (...)
[LineBlame] repository busy, deferring update (...)
```

## 二、hover 命中区域：悬停在 blame 文本上没有提示（已复现，待修）

- **现象**：悬停在行尾左侧的实际文本上 → tooltip 正常；悬停在行尾的 line blame 文本上 → tooltip 不出现。
- **原因**：提示来自装饰的 `hoverMessage`，它只对装饰 **range 覆盖的文本**生效；blame 是 `renderOptions.after` 渲染的伪元素，位于 range 之外，Monaco 不把它算作 hover 目标。
- **复现**：`src/test/e2e/line-blame.spec.ts` → `Shows the tooltip when hovering the blame text`
  —— 悬停 blame 文本，`.monaco-hover` 5s 内始终 `hidden`，用例失败 ✓。
- **目标**：按整行 hover 显示；优先支持悬停 blame 文本，整行命中也可接受。

### 方案（按改动从小到大）

- ~~**H1 hover-only 装饰**~~（已试，**无效**）：行尾零宽 `(line, len)-(line, len)` 且带 `hoverMessage`，
  悬停 blame 文本时 tooltip 仍不出现；顺带使 e2e 的 `immediate` 断言暴露竞态（已删除该断言）。
  → Monaco 对空 range 装饰不派发 hover。
- **H2 `registerHoverProvider`**（已实现）：维护 `(uri, line) → markdown`，hover 落在已装饰行时返回整行 range 的 markdown；
  主装饰不再挂 `hoverMessage`（单一来源）。
  **结果**：`Shows the blame tooltip for the cursor line` 通过（行内任意位置都有 tooltip）；
  `Shows the tooltip when hovering the blame text` **仍失败** —— 说明 Monaco 根本不为 `after` 伪元素区域派发 hover；
  provider 只会收到文档内位置，伪元素区域没有对应位置。
- **H3（未做，成本高）** 把 blame 从装饰改为真实 DOM 组件（inline widget / view zone）：能命中 hover，
  但要自己处理滚动、折行、点击、主题、性能，属于重写渲染层。

### 结论（已解决）

- **H2 生效**：`registerHoverProvider` + 整行 range 已经让"悬停 blame 文本"正常出 tooltip。
- 之前误判"死区"的原因：e2e 的悬停坐标算错了 —— 伪元素宿主可能是整行容器，`getBoundingClientRect().right`
  是编辑区右边界而不是 blame 文本起点；改为"行文本末端 + 45px"后用例通过。
- 现状：`Shows the blame tooltip for the cursor line`、`Shows the tooltip when hovering the blame text`、
  `Keeps the blame text at the end of the line while editing` 三个 e2e 全部通过。
- 参考实现（GitLens）：同样用 `after.contentText` 渲染 blame，tooltip 不依赖 `hoverMessage`，而是由
  `LineHoverController`（自定义 HoverProvider）返回 MarkdownString；编辑中（`e.editing`）会清空注解。
  我们的 H2 与其一致。

# AGENTS.md

## 协作

- 使用中文回答
- 未说 执行或实施 前，只给出方案，不要动代码
- 每轮对话结束后，执行 diff 命令，根据**真实 diff** 输出提交信息，禁止只凭记忆给出；非必要时，提交信息只需要一句话的标题
- 写临时脚本验证时，不要修改项目外路径，全部在项目内的 tmp 目录下完成
- 删除命令禁止添加 force 参数（`Remove-Item -Force`、`rm -f`、`-Recurse -Force` 等），防止误删；命令因缺少 force 而失败时，先确认路径再决定，不得改用其他强制手段绕过

## 工具使用

- `replace_in_file` 必须同时给出 `filePath`、`old_str`、`new_str`；`old_str` 用**唯一且短的锚点**（带 3 行以上上下文），不要整段粘贴
- 编辑失败后**立刻 `read_file` 核对当前文件内容**再重试；同一文件连续 2 次失败必须重读全文，禁止第 3 次盲改
- 文件内容写入只用 `write_to_file` / `replace_in_file`；**不用 shell 重定向写文件**（PowerShell 反引号、编码、换行都会破坏模板字符串与 LF 约定）
- 一次性探针脚本写成项目内 `tmp/*.mjs` 用 `node` 执行，避免 PowerShell 引号、与编码问题

## 测试与验证

- 使用 && 串联命令
- **禁止猜方案**：每一步必须先读代码/日志/文档确认事实，再行动。不允许"可能""也许""应该是"式的猜测。不确定时停下来看代码，不要试错。
- 每次收尾必须通过 `pnpm check`（= `format` → `check-types` → `lint` → `check:bundle` → `test:unit`）。`format` 为改写式，自动修复格式差异即算通过；`lint` 带 `--error-on-warnings`，warn 级诊断也会失败。`check` 未通过不得提交或宣布完成。`build` / `check-license` 不纳入（仅 package 时用）
- 执行 `package.json` scripts 里的**任何命令**（`pnpm test:unit`、repo 测试、`playwright test`、build、lint 等）都必须读**完整的原始输出**再判断成败；禁止 `Select-String`、`Select-Object -Last/-First N`、`| head`、`| tail`、`grep`、`-c` 等截断或筛选后直接下结论——失败信息常夹在输出中段，只看尾部会把失败误判成通过
- 需要定位信息时优先用命令自身开关收窄范围（`playwright --grep`、Vitest 文件过滤、日志级别）；额外 grep 只能作为补充确认，不能替代完整阅读
- 输出确实过长时只允许重定向到 `tmp/*.log` 后**完整读取文件**（可分段读），不得在管道里按关键字筛选；结论需注明完整输出的路径
- 理由：被过滤掉的往往是断言值/堆栈/失败步骤，截断会误判并导致返工，省 token 得不偿失（来源：`d:/py-code/pbp/跨项目通用规则.md:29-33`）
- e2e 测试里的 timeout 上限 5 秒；确需超过时必须在代码里加注释说明原因
- 单测（`vitest.config.ts`）的 `testTimeout` / `hookTimeout` 固定 5 秒：超过就是分层放错，应下沉到 repo 层而不是放宽超时
- 新增或修改测试前，先按 `测试体系.md` 判断该放哪一层：UI 行为才用 e2e；真实 jj 语义用 repo；纯逻辑用 unit。同一行为的矩阵放轻层，e2e 只验证接线；禁止在 e2e 里用 TestRepo 复算仓库状态，也禁止为提示文案去 e2e 抓原生通知 DOM

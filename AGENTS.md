# AGENTS.md

## 协作

- 使用中文回答
- 未说 执行或实施 前，只给出方案，不要动代码
- 每轮对话结束后，执行 diff 命令，根据**真实 diff** 输出提交信息，禁止只凭记忆给出；非必要时，提交信息只需要一句话的标题
- 写临时脚本验证时，不要修改项目外路径，全部在项目内的 tmp 目录下完成
- 删除命令禁止添加 force 参数（`Remove-Item -Force`、`rm -f`、`-Recurse -Force` 等），防止误删；命令因缺少 force 而失败时，先确认路径再决定，不得改用其他强制手段绕过

## 测试与验证

- 修改代码后必须**先通过 `pnpm lint`（含 `pnpm check-types`）再跑测试**；lint 未通过不得进入测试阶段
- 执行**任何测试命令**（`pnpm test:unit`、repo 测试、`playwright test`、build、lint 等）都不要截断输出，必须读取完整的原始输出；禁止用 `Select-String`、`Select-Object -Last N`、`| head`、`| tail` 等过滤或截取
- 输出过长时只允许重定向到 `tmp/*.log` 后**完整读取文件**（可分段读），不得在管道里按关键字筛选
- 理由：被过滤掉的往往是断言值/堆栈/失败步骤，截断会误判并导致返工，省 token 得不偿失
- e2e 测试里的 timeout 上限 5 秒；确需超过时必须在代码里加注释说明原因

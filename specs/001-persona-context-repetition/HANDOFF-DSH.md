# DSH Agent 实施交接：001 互斥双阶段输出画像

## 开始条件

旧版批准已因实际验收失败撤回。只有用户明确批准当前 `SPEC.md`、`ACCEPTANCE.md` 与本交接后，DSH Agent 才能修改产品代码。用户要求“修订 Spec”不等于批准实施。

批准后先在 `D:\ai\MistyMoon-DSH` 运行：

```powershell
git status --short --branch
```

当前工作区包含上一轮实施 Agent 的未提交实现、用户文档和研究材料，全部视为用户所有。只能在批准范围内就地修正；禁止 reset、checkout、clean、覆盖或清理其他修改。

## 权限与边界

- 只修改批准 Spec 允许的 MistyMoon 文件。
- 不得修改 `D:\ai\deepseek-harness` 任何源码、文档、配置、测试、lockfile 或 Git 状态。
- 开始时只读核对 DSH 官方远端最新 `master` 和相关 public seam；发生不兼容变化时停止并报告。
- 不读取真实 persona、memory、character card、credential、用户 Home、session或日志；测试只用中性数据和临时目录。
- 不修改已批准的三个 Spec 文件，不自行扩大功能、升级无关依赖或重构无关 Module。
- 不修改 `.research/**`，不把研究材料或本机私有路径复制进测试/报告。
- 不 commit、push、安装、发布、建 PR/Release或修改远端，除非用户另行授权。

## 实施原则

目标是一个 deep `PersonaTurnDeliveryCoordinator`，不是两套独立状态机：

- `Turn Voice Capsule`：每个 active RP owner turn在真实 owner message后恰好一次，轻量、logged、best-effort短对话兜底。
- `Final Voice Refresh`：保留现有 `mistymoon_prepare_final_reply`；合法 sole call后先 neutralize initial，再启用恰好一个 refresh，下一 request tools为空，用于长任务抗稀释。
- 任一 provider request 最多一个 active voice profile；surface replacement 是非指令性的 lifecycle record，不能用全局禁令与下一 turn 的 profile 冲突。
- 不得注册常驻 Persona system section，不得按 assistant/tool step重复投影，不得 post-hoc revoice。

## 实施顺序

1. 完整阅读批准的 Spec/Acceptance/Handoff、MistyMoon AGENTS/README/architecture、当前未提交 diff，以及 DSH 官方 Tools、Agent Loop、pre-step、turn lifecycle、restriction、session surface文档/源码。
2. 先写回归与保留测试，不改产品实现：
   - short direct without prepare必须有 one owner-tail profile、one request、one final；
   - 长链必须有 one initial profile、nine business calls、sole prepare、initial neutralized、one active refresh、empty-tools final；
   - prepared final 的任一 request active profile合计不得超过一；
   - 第一 prepared turn结束后开始第二 owner turn，所有 previous lifecycle replacements不得包含 `no persona or voice instructions apply now` 或等价的 active/global prohibition；
   - initial renderer 在最小/默认/大预算下必须保留完整 activation/operational block，不含任意 `style.instructions`/reference dialog，也不允许字符级截断；
   - short direct 是保留测试，当前实现可为绿；当前实现必须因双 active profile、跨 turn prohibition与任意字符截断在其余新增测试上稳定红灯。
3. 运行并记录红灯命令、失败 request index、section/source和 tools；禁止先改测试去迎合实现。
4. 删除固定 anchor、legacy continuation和ordinary full snapshot生成路径；保留 legacy读取兼容测试。
5. 在 Foundation 内实现/收敛 `PersonaTurnDeliveryCoordinator`：owner-tail、field-aware render budget、source metadata、去重、prepare state transition、restriction、neutral replacement、cancel/dispose、并发和resume都由此 Module拥有。
6. 在真实 owner message落盘后、首 request前追加一次 logged `mistymoon:turn-voice`。Renderer-owned 控制文本使用 output-presentation/speaker/relationship/voice traits，不使用 persona/roleplay/Companion identity/Expression guidance；activation 仅适用于“无 tool call且结束 owner turn”的 response。Initial 不读取任意 `style.instructions`或reference dialog，mandatory block不可截断，optional字段只能整项取舍。
7. 保留 prepare tool；合法 sole call必须先把 active initial surface替换为 neutral superseded record，再排队 one logged `mistymoon:final-voice-refresh`并安装 Agent-scoped empty-tool gate。不得存在两个 active profiles的 provider request；短对话不需要调用 prepare。
8. direct/prepared final、cancel、error、dispose后把 active profile替换为 neutral lifecycle record并清理 restriction；record只陈述历史事实，不含当前/未来命令或禁止。不得删除 raw events或生成第二份回复。
9. 实现真正的 restart/resume：prepare已记录且 final未完成时从 durable facts恢复；不得用全新 Agent重新 prepare冒充。
10. Code Mode不能证明等价 final gate时实现并测试“owner-tail only”支持，不修改 DSH/`run_code`。
11. 更新直接相关 README、architecture、AGENTS事实和必要组合/built/UI测试。
12. 先跑定向测试，再跑 build、built smoke、publication audit、`git diff --check`、`pnpm check`。

## 必须保持的不变量

- system prompt永远没有 MistyMoon persona/anchor。
- 每个 active owner turn恰好一条 initial capsule；后续 request重放同一历史消息不等于新增 projection。
- 每 turn最多一个合法 refresh；prepare request本身没有 refresh，紧随其后的 empty-tools request才有。
- 每 request active initial + active refresh <= 1；legal prepare先 neutralize initial，再 append refresh。
- skip prepare时直接 final，不增加模型 call，由 initial capsule提供best-effort人格。
- initial profile只含结构化小型 output presentation字段；任意 `style.instructions`与完整 reference dialog只允许在合法 refresh。
- initial activation与operational block永远完整；预算不得产生半句。Lifecycle record永远是事实而非 prompt 指令。
- 所有模型可见文本进入 DSH session log，metadata/tool/UI不泄露正文。
- final/cancel/error/restart/dispose不泄漏 restriction、capsule或 Agent身份。
- Bundle只组合；Settings、Memory、Importer不参与。
- Coding、Plan、工具、权限、审批、安全和模型路由不被 Persona改变。

## 必须停止并提交问题

- 官方远端相关 public seam已变化或当前 peer floor不支持 required interface。
- 无法确认“真实 owner message后、首 request前”这一 ordering。
- 无法用官方 seam让 prepared final request tools为空。
- 无法用 session log重建 initial/refresh或 pending prepared状态。
- expiry需要删除/改写 raw events。
- 正确实现需要修改 DSH、preset/Profile、未授权包或私有数据格式。
- Code Mode只能通过修改 DSH/`run_code`支持；此时按 owner-tail only降级，不自行扩展。
- UI自动化需要复制或修改 DSH Client。
- 用户已有修改与批准范围重叠且无法安全区分。
- 任一选择会恢复每请求新 Persona、自动 step/token refresh或事后第二回复。
- 无法通过公开 replace seam在 append refresh前使 initial inactive，或无法机械证明任一 request最多一个 active profile。

问题报告只含公开代码位置、中性复现、2–3个选项和推荐，不含私有内容。发现 Spec歧义必须停止实现并提交问题；不得自行修改 Spec。

## 必须运行的验证

至少包括：

```powershell
pnpm exec vitest run packages/foundation/tests/persona-projection.spec.ts packages/foundation/tests/agent-loop-persona.spec.ts packages/foundation/tests/final-reply.spec.ts packages/installer/tests/root-bundle.spec.ts
pnpm exec vitest run packages/settings-ui/tests/settings.spec.ts
pnpm build
pnpm smoke:built
pnpm audit:publication
git diff --check
pnpm check
```

还必须按 Acceptance运行 short direct、short prepare、十一请求长链、长链 skip、off、sibling、duplicate、retry、cancel、真正 restart/resume、two-agent、Native/complete/Code Mode支持矩阵。只报告实际执行过的命令和结果。

## 完成报告

完成后停止并等待 Codex独立验收，报告：

1. 修改文件及各自职责。
2. 实施前回归红灯命令和精确失败原因。
3. 实际测试命令及 pass/fail/skip。
4. short direct逐请求 capsule/system/tools/model-call计数。
5. 长链逐请求 active initial/active refresh/lifecycle record计数、tool names和final tools数组。
6. Initial renderer的 forbidden framework phrase、freeform omission和最小/默认/大预算完整性结果。
7. off、skip、sibling、duplicate、retry、cancel、dispose、two-agent、restart/resume和legacy结果。
8. Native/Anchored Standard、complete、Code Mode支持矩阵。
9. 与批准 Spec的所有偏差；预期为“无”。
10. 剩余风险，尤其真实 DeepSeek人格质量和推理稳定性不能由mock证明。
11. Git状态；确认未 commit/push/publish、DSH与 `.research/**` 未改动。

任何未声明偏差均视为验收失败。最终合并、安装、发布和部署由用户决定。

## 可直接复制给 DSH Agent 的实施提示词

```text
你是 MistyMoon-DSH 的实施 Agent。只有用户明确批准 D:\ai\MistyMoon-DSH\specs\001-persona-context-repetition\SPEC.md、ACCEPTANCE.md 和 HANDOFF-DSH.md 后才能开始；“修订 Spec”不等于批准实施。

先运行 git status --short --branch。当前未提交产品实现、文档和研究材料全部属于用户；禁止 reset/checkout/clean或覆盖。不得修改 D:\ai\deepseek-harness、.research/**、用户 Home、私有人格/记忆/角色卡/凭据/会话，也不得 commit、push、安装、发布或修改远端。只读核对 DSH官方最新 master；public seam变化时停止报告。

严格按已批准的三个文件实施，不得修改 Spec、扩大范围或重构无关 Module。先写并运行四组回归：一，模型首请求直接自然回复、不调用 prepare时，真实 owner message后必须有恰好一条 logged mistymoon:turn-voice，整个 turn只有一个模型 call和一个 final；这是现有短路径保留测试，可为绿。二，九次中性业务工具、一次 sole mistymoon_prepare_final_reply、一次 final的长链，prepare必须先 neutralize initial，prepared final只有一条 active mistymoon:final-voice-refresh且 tools为空；三，第一 prepared turn后开始第二 owner turn，previous lifecycle records不得包含 no persona/ignore persona/do not roleplay等当前或全局禁令；四，initial renderer不含任意 style.instructions/reference dialog，mandatory activation/operational block在所有合法预算下完整，optional字段不得字符级截断。后二至四必须在当前实现上记录精确红灯，再修改产品代码。

实现一个 deep PersonaTurnDeliveryCoordinator统一拥有 owner-tail profile、field-aware渲染预算、source metadata、exactly-once、prepare状态转移、Agent-scoped empty-tool restriction、neutral surface replacement、cancel/dispose、并发和durable restart/resume。Initial renderer-owned文本使用 output presentation profile、Speaker label、Relationship register、Voice traits；activation只适用于无tool call并结束owner turn的response，不使用persona/roleplay/Companion identity/Expression guidance。Persona不得进入 system prompt；不得每step新增 capsule/continuation/anchor；short skip prepare不得追加第二模型调用；任意style.instructions和完整reference dialog只允许在合法 final refresh。所有模型可见内容必须进入 DSH session log。

保留现有 prepare工具作为长程抗稀释路径。合法 sole call后先用非指令性 lifecycle fact替换 initial，再排队one active refresh并使下一 request tools为空；任一 request active profiles合计不得超过一。final/cancel/error后用 neutral consumed record替换 active profile并清理 restriction；replacement不得包含现在或未来适用的命令/禁止。restart测试必须从“prepare已记录、initial已neutralize、final未完成”恢复，不能重新 prepare冒充。Code Mode不能证明等价 gate时只支持 owner-tail，不修改 DSH或run_code。

发现 Spec歧义、public seam不足、需要越界修改或无法日志重建时立即停止并提交中性问题，不自行决定。完成后运行批准 Acceptance中的定向测试、组合、built smoke、settings RPC、publication audit、git diff --check和pnpm check。报告修改文件、红灯、所有实际命令、short/long逐请求结果、恢复与模式支持矩阵、偏差和剩余风险，然后等待 Codex独立验收。
```

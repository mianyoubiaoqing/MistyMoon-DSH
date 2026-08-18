# 001 验收标准：互斥双阶段输出画像

## 0. Preset 策略分流

- `mistymoon-rp-host-v1` 的请求含完整已发布 Persona 的 `deployment:persona`，且 `request/header.system` 可重建实际文本。
- RP Host 请求与工具目录不含 turn-voice、final-voice-refresh 或 `mistymoon_prepare_final_reply`。
- 同一 Foundation 进程中的非 RP preset 仍通过本文其余全部双阶段验收；RP Host 的启用与卸载不得改变它们。
- child、伪造 header、自称 RP Host 或非 Owner turn 均不能启用 RP Host system projection。

本文件取代旧版“每请求固定 anchor”和“prepare-only、skip 时零人格”的验收标准。除明确标为真实模型或用户手工 Review 的项目外，结果必须可机械验证。测试只使用中性生成 persona、临时目录和 deterministic Adapter。

## 1. 修复前回归与保留测试

实施 Agent 必须先写测试并在修改产品实现前记录结果。第 1.2–1.4 节必须在当前双层实现上稳定红灯；第 1.1 节是已经实现的短路径保留测试，不得为解决冲突而回退。

### 1.1 一步式短对话

脚本：owner 发送中性问候，模型第一次请求直接返回自然语言，不调用 prepare。

新断言：

- 只有一个 provider request。
- request system 不含 MistyMoon persona/anchor。
- request messages 中真实 owner message 后紧跟一条 `mistymoon:turn-voice`。
- session 中恰好一条对应 `user/message`，final 后 current surface 由非指令性的 neutral consumed record 取代。
- 不存在 prepare call、steer、revoice 或第二个 assistant final。

历史 prepare-only 实现因没有 `turn-voice` 而失败；当前双层实现应通过，本次修改后必须继续通过。

### 1.2 长工具链

脚本：owner message；模型连续九次 sole 中性 `echo`；第十次 sole `mistymoon_prepare_final_reply`；第十一次自然语言 final。

新断言：

- request 1–10 都引用同一条 `mistymoon:turn-voice`，但 session 只有一个 projection event/source id。
- request 1–10 没有 `final-voice-refresh`，system 中没有 persona/anchor。
- legal prepare 必须在 append refresh 前把 initial surface 替换为 neutral superseded record。
- request 11 恰好包含一条 active `mistymoon:final-voice-refresh`、零条 active `mistymoon:turn-voice`，tools 为空；neutral lifecycle records 不计为 active profile。
- final 后 refresh 由 neutral consumed record 取代，普通工具恢复。

旧固定 anchor 实现因 system 泄漏而失败；当前双层实现因 request 11 同时保留 active initial 与 active refresh 而失败。

红灯必须报告精确 request index、section/source id、system/persona 计数和 tool names，不能只靠截图。

### 1.3 跨 turn 冲突指令

脚本：第一 owner turn 走 legal prepare + final；同一 session 随后开始第二 owner turn并捕获其首个 provider request。

新断言：

- 第二 turn 有且仅有其自己的 active `turn-voice`。
- 所有 previous-turn replacement 都只是 lifecycle fact，不含 `no persona`、`ignore persona`、`do not roleplay`、`apply now` 或等价的现在/未来命令与禁止。
- 任一捕获请求中 active `turn-voice` 与 active `final-voice-refresh` 合计不超过一。

当前实现会稳定派生两条 `no persona or voice instructions apply now` replacement，并在 prepared final request 同时保留两个 active profiles，因此必须先红灯。

### 1.4 Initial profile renderer

对中性 persona 分别使用最小、默认和大预算渲染，另提供超长 optional fields。

新断言：

- renderer-owned 控制文本包含完整 `Activation` 与 `Operational behavior` block。
- `Activation` 明确规定仅对“无 tool call 且结束 owner turn”的 response 应用；tool-calling response 不做 presentation changes。
- renderer-owned 控制文本不含 `roleplay`、`persona`、`Companion identity` 或 `Expression guidance`。
- initial profile 不含 `style.instructions` 与 reference dialog 的测试 sentinel。
- optional field 只按完整字段/整行加入或省略；结果无字符级截断、半句或用于截断的省略号。
- 小于 mandatory block 的配置在插件加载时明确失败，不产生残缺 prompt。

## 2. 核心机械不变量

- RP active 时，每个真实 owner turn 恰好一个 `turn-voice` projection；RP off 时为零。
- 每个 owner turn 最多一个合法 `final-voice-refresh`；其数量由成功 prepare 次数限定。
- 任一 provider request 中 active `turn-voice` 与 active `final-voice-refresh` 合计不超过一。
- Persona 永不出现在 DSH system prompt、tool schema、tool result、UI metadata 或 lifecycle marker。
- owner-tail ordering 是：真实 owner message → `turn-voice` → 后续 assistant/tool messages。
- 同一 turn 的后续请求可以重放同一 capsule，但不得生成新的 capsule/continuation/anchor event。
- 初始 profile 不得包含任意 `style.instructions` 或 reference dialog；final refresh 可按 RP mode包含更完整的已发布 persona。
- 初始 profile 的 mandatory scope/activation/operational block 始终完整，optional field 按字段预算，不允许字符级裁切。
- consumed/superseded marker 只能陈述生命周期事实，不能指示模型现在或未来忽略/应用 persona、voice 或 roleplay。
- skip prepare 不增加模型 call；直接 final 保持原文，不事后重写。
- legal prepare 后下一 request 的有效 tools 为 `[]` 或省略。
- final/cancel/error/dispose 后下一 owner request 不含上一 turn 的两种 capsule，工具恢复。
- raw session events 保留，active current surface 被 neutral lifecycle record 取代；任何模型可见文本可从 log 重建。

机械源码检查：

```powershell
rg -n "ROLEPLAY_ANCHOR|mistymoon:roleplay-anchor|renderRoleplayContinuation|mistymoon:roleplay-continuation" packages README.md docs AGENTS.md
```

预期：运行时代码和当前事实文档无匹配。仅 legacy 中性 fixture 可引用旧字符串，且必须证明不会再次生成。

## 3. `PersonaTurnDeliveryCoordinator` 单元测试

通过 Module Interface 覆盖：

- companion/immersive 的 owner turn 各投影一条受预算 profile；两者的 initial profile 都不含任意 `style.instructions` 或 reference dialog。
- initial renderer 在最小/默认/大预算下保持完整 activation/operational block，optional speaker/relationship/traits 只整项加入或省略；非法过小配置 load-time fail loud。
- capsule source 包含中性 owner turn、persona version/hash 和 section，metadata 不含正文。
- retry、重复 pre-step、HMR callback 和多个 assistant/tool step 不产生第二条 capsule。
- `off` 不读取 persona、不投影、不注册 refresh gate。
- persona 文件缺失、JSON/schema 失败时 fail open for Coding：不使用 stale/template，不限制工具，返回中性诊断。
- legal sole prepare 先 neutralize initial surface，再排队一条 refresh并安装一个 Agent-scoped empty-tool restriction；可观察状态中不存在两个 active profiles 的中间或最终请求。
- sibling/duplicate prepare、missing/disposed agent、取消、restriction 安装失败均不产生半 armed 状态。
- provider retry 复用同一 logged refresh，不重复 append。
- direct final、prepared final、cancel、error和 dispose 分别执行幂等 neutral replacement/cleanup；replacement 不含 active/global prompt 指令。
- 两个 Agent 并行时 capsule、mode、gate和 disposer不串号；身份使用 DSH opaque/branded identity，不以裸字符串 map 作为唯一关系。
- resume 只从 durable session facts恢复 pending refresh；prepare 已记录而 final 未完成的场景重启后仍为空工具且不重复 refresh。
- durable facts歧义时 fail closed for refresh，但不破坏 DSH 普通工具/权限。

Tests 不能直接断言 implementation `Map`/`WeakSet`；只能通过 session events、provider messages、tools、tool result和 disposer observable effect 验证。

## 4. 短对话真实 Agent Loop

使用官方 DSH Agent Loop、session 和 deterministic Adapter 覆盖：

1. direct final without prepare；
2. 第一次 sole prepare、第二次 final；
3. `/rp off` direct final。

必须断言：

- direct path 一个 request、一个 assistant final、一个初始 capsule、零 refresh。
- prepared path 两个 requests；第一个含 active initial，第二个含 neutral superseded record 与唯一 active refresh且 tools为空。
- off path 两种 capsule均为零。
- 所有 final 后 active surface 均被 neutral lifecycle record 取代；下一 owner turn生成新的 profile而非复用旧 source id，且不受 previous-turn prohibition 约束。
- owner text、DSH system、Plan/permission/security内容与未加载 Foundation 的 control相同；唯一允许差异是 user-tail capsule和 prepare tool schema。

## 5. 长工具链与稀释刷新

运行第 1.2 节十一请求场景，断言：

- 九个 echo call/result 正常；prepare 为第十个且是 sole call。
- requests 1–10 的 system、业务 tool schema、任务历史与 control相同，允许新增 prepare schema和同一条初始 capsule。
- session 只有一个 `turn-voice` event；不得因为十次请求产生十个绿色投影块。
- prepare 后 initial active surface 已被替换；request 11 有且只有一个 active refresh、无 active initial、无 echo/prepare/run_code/其他 tools。
- final assistant 是唯一 owner-facing final；不存在无人格草稿后再二次回复。
- prepare call/result、initial profile、neutral superseded/consumed records、refresh和 final assistant均进入日志并可重建。
- final 后第二个 owner turn普通工具出现，上一 turn persona不可见。

另测长链跳过 prepare并直接 final：只有初始 capsule，无 refresh、无额外模型调用，系统正常完成。该测试证明失败行为，不证明长程人格质量。

## 6. 重启、恢复和错误协议

组合测试必须覆盖：

- 初始 capsule已记录、首个请求前重启：不重复 capsule，turn正常继续。
- prepare call/result和 refresh已记录、final 尚未生成时重启/官方 resume：重建 empty-tool gate，复用同一 refresh，完成后清理。
- previous test 不能用“创建全新 Agent 后重新 prepare”冒充 resume。
- prepare 与 echo 并列：prepare拒绝，echo按 DSH 正常执行，initial capsule保留，下一请求工具未被清空。
- prepare 后 provider error/retry：initial 保持 neutral superseded，同一 active refresh和空工具，不重复 event。
- prepare 后用户取消：restriction清理，所有 active surface 被 neutral lifecycle record 取代，不伪造 final。
- Foundation dispose/reload：不泄漏 tool、listener、restriction或重复 projection。
- 两 Agent 并发：一个 armed 不影响另一个。

## 7. Native、Anchored Standard、complete 与 Code Mode

- ordinary Native tool presentation 自动测试是 Anchored Standard seam 的最小等价验证。
- Anchored Standard 的真实 DeepSeek A/B 属于手工验收；不能由 scripted Adapter证明推理稳定性。
- complete/minimal 的 direct path应获得 owner-tail capsule；支持 prepare时验证 refresh，不支持时仍由初始 capsule完成。
- Code Mode 必须证明 Foundation 不改变 `run_code`、业务工具、权限、system prompt或执行结果。
- nested prepare 只有在 sole-call、durable resume、empty-tool final和cleanup全部可证明时启用；否则支持矩阵明确为“owner-tail only”。
- 不得为兼容任何模式修改 DSH、preset或用户 Profile。

## 8. 插件组合加载测试

Cordis/Loader 测试断言：

- Foundation 注册一个 prepare tool、一个 owner-tail/final coordinator所需的最小生命周期 Adapter集合。
- 没有 Persona `SystemPrompt.section()` Provider。
- Bundle 只组合和提供默认配置；Settings、Memory、Importer独立加载且不参与状态机。
- dispose/reload不泄漏或重复注册。
- Foundation 不直接读取 Memory/Settings内部文件。

至少运行：

```powershell
pnpm exec vitest run packages/foundation/tests/persona-projection.spec.ts packages/foundation/tests/agent-loop-persona.spec.ts packages/foundation/tests/final-reply.spec.ts packages/installer/tests/root-bundle.spec.ts
```

## 9. 构建后 Cordis 冒烟测试

```powershell
pnpm build
pnpm smoke:built
```

Built smoke 必须从 `packages/foundation/lib` 验证：

- direct short：owner → one active profile → direct final → neutral consumed record；
- long：one active profile → business tools → prepare → neutral superseded record + one active refresh/tools empty → final → neutral consumed record；
- off：零 persona projection；
- reload：无重复 registration。

Source-only mock通过不能替代 built smoke。

## 10. UI 与 RPC

Settings Host/RPC schema原则上不变，运行：

```powershell
pnpm exec vitest run packages/settings-ui/tests/settings.spec.ts
```

UI/RPC可观察行为：

- 每个 owner turn开始后最多显示一个中性标识的 turn-voice Input 块，不在每个 assistant/model step 前新增绿色块。
- prepare显示一个不含私密内容的 generic tool card。
- 合法 prepare后只显示一个 final refresh Input块。
- prepared final 对应的模型请求不得同时显示 active initial 与 active refresh；旧块只能以非指令性的 lifecycle record 存在。
- final后不出现第二份 assistant改写回复。
- UI diagnostics只展示 source、position、reason、estimated tokens、turn/step、persona version hash和projection kind，不展示 persona正文。

若仓库没有时间线自动化 seam，使用中性 deterministic session fixture并由用户手工 Review，不复制 DSH Client。

## 11. 兼容性和旧数据

Seed 中性 rc2、固定 anchor和prepare-only session，断言：

- 原始 events不删除/改写，格式版本不提高。
- 新实现不追加 legacy full/continuation/anchor。
- 报告当前 surface是否仍含 legacy persona，不宣称旧会话立即满足新语义。
- Persona v1/v2、Memory JSONL、Settings RPC、Character Card和Installer既有兼容测试继续通过。

## 12. 隐私发布审计

```powershell
pnpm audit:publication
git diff --check
git status --short
```

Fixture、snapshot、UI metadata和报告只含中性生成数据；不得包含真实 persona、memory、card、credential、本机私有路径、session或日志。`.research/**` 不得被实施 Agent修改、暂存或复制进报告。

## 13. 最终门禁

定向测试通过后运行：

```powershell
pnpm check
```

实施 Agent只报告实际运行的命令。Codex 独立验收必须重跑短 direct、短 prepare、十一请求长链、长链 skip、sibling、retry、cancel、真正 restart/resume、两 Agent隔离、Native/complete/Code Mode、built smoke、publication audit和 `git diff --check`，不能依赖实施报告。

## 14. 真实 DeepSeek 与用户手工 Review

1. Anchored Standard + companion 日常短对话：不调用 prepare，只有一个 owner-tail块，最终仍有可识别 companion风格。
2. Anchored Standard + companion 至少八个业务工具步骤：中间不新增人格块；模型调用 prepare后 initial 先失活，final request 只有一个 active refresh，最终风格达到用户当前已验证的基线。
3. 对照关闭 Foundation 的同任务，Review Coding/Plan/工具选择、事实和稳定性；CoT 不应再出现因框架措辞触发的 “Do I need to avoid roleplaying?” 身份仲裁，初始 profile 不得造成明显退化。
4. immersive重复短/长路径；初始 capsule保持小型，完整 persona只在refresh出现。
5. `/rp off` 重复任务；全程零 persona投影。
6. 长任务可控跳过 prepare：接受 best-effort降级，不出现第二回复。
7. final后继续新 owner turn；上一 turn capsule不可见，普通工具恢复。
8. DSH重启后恢复 pending prepared final，确认不是重新调用 prepare。

自动测试只能证明输入结构，不能替代上述人格质量和推理稳定性 Review。

## 15. 验收失败条件

任一项成立即失败：

- Persona出现在 system prompt或每 step产生新的 capsule/continuation/anchor；
- 同一 owner turn产生两条 initial capsule或两条合法 refresh；
- 任一 provider request 同时存在 active initial 与 active refresh；
- 初始 profile不是紧随真实 owner message，包含 `style.instructions`/reference dialog，或 renderer-owned 文本使用 persona/roleplay/companion identity 仲裁措辞；
- initial mandatory block 被截断、optional field 被字符级裁切，或过小预算未在加载时失败；
- consumed/superseded replacement 含 `no persona`、`ignore persona`、`do not roleplay` 或其他现在/未来适用的命令/禁止；
- short direct因跳过 prepare而没有 initial capsule，或被追加第二次模型回复；
- legal prepare后的 final request仍有业务工具；
- 通过 step/time/token/工具名/自然语言 heuristic自动刷新人格；
- final/cancel/error后 capsule或 restriction泄漏到下一 turn/其他 Agent；
- restart测试以重新 prepare冒充恢复；
- 模型可见内容未记录，或私密 persona出现在 tool/UI/fixture/报告；
- 修改 DSH、preset/Profile、Memory/Settings/Importer/Bundle业务逻辑或数据格式；
- 未声明偏差、必需检查失败却报告完成，或 scripted mock被描述为真实人格质量证明。

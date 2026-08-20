# 011 验收标准：RP Host / Work Agent 委派预设

本文件验收设计与未来实现；当前草案不表示 preset 已安装或可用。

独立 preset 的 spawn-time selection、共享基线和 one-shot activation 之间的 logical profile switch 由 [014 验收标准](../014-switchable-work-agent/ACCEPTANCE.md)负责；011 的 one-shot 基线不在已有 turn 的同一 Session 上切换 preset。

## 1. Owner Eligibility 阻断门

- [x] delegated message 虽为 `source.kind=user`，但 `delegationDepth>0` 时不生成 Foundation voice/final refresh。
- [x] child 不获得 Companion Reality recall，不观察“请记住”，也不能调用记忆确认/纠正/删除。
- [x] 认证 Owner、普通 DSH user source、depth 0 三项缺一时 fail closed。
- [x] Foundation 与 Memory 使用同一 Eligibility Interface，不各自复制判断。

上述四项已由 015 完成；preset discovery、真实 child 与模型路由仍须分别通过后续验收，当前不得对用户开放。

## 2. 预设与交付

- 在中性临时 DSH Home provision 后，rc.7 discovery 能列出并挂载 `mistymoon-work-anchored-standard-v2`。
- `preset.yml` 只有中性展示数据，不含 Persona、Memory、凭据或本机路径。
- 目标目录存在时拒绝覆盖；升级、回滚、删除各需显式确认。
- 不修改 DSH 安装目录、Profile、其他 preset 或私有 discovery 状态。

## 3. RP Host 组合与工具隔离

- 首次及 compaction/restart 后的 system prompt 含完整已发布 Persona 的唯一 `deployment:persona` section，并以其作为模型可见运行时身份；安全、权限、沙箱、审批、协作模式、外部副作用与未知 policy section 保留，只有 `harness:identity` 文案被精确移除，`request/header.system` 可重建实际文本。
- 工具 catalog 含 `web_search` / `web_fetch` / `read` / `grep` / `glob` 和已资格化的 `mistymoon_code_flash`，不含 Pro、shell、edit、write、patch、Git、代码执行或 browser side-effect 工具。`read` / `grep` / `glob` 只接受真实路径仍在当前 Session 工作区内的目标，绝对路径、父目录与符号链接越界均在执行前拒绝。
- 设置页只列出 DSH 实时 registry 中能通过 `resolveCallConfig(... max)` 的 provider/model；DSH 删除或禁用的 route 不可保存。
- 默认 direct Flash 不要求额外确认；任意非默认 exact pair 显示 experimental 警告，Owner 点击保存后只改变之后的 fresh child，已有或运行中的 child 不重绑。
- 私有模型设置只包含版本、revision、provider/model 引用、固定 `max` 与 qualification，不包含 key、base URL、余额、账户或模型提供商配置。route 缺失、region、quota/rate 或 provider 错误 fail loud，且不创建 fallback child。
- 直接尝试调用这些工具在 schema/执行 gate 失败，而不是依赖 prompt 自律。
- RP Host 不含 `mistymoon_prepare_final_reply`、turn-voice 或 final-voice-refresh；通用 preset 仍保留三者和原有序列测试。
- DSH safety、permissions、Plan、AGENTS 和 skill governance sections 保持存在。
- DSH rc.7 未标记 section 是否为可过滤工具帮助，因此未知 `tool:*` / `tools:*` section 默认保留；prompt section 名称不充当 capability gate。
- Composition 不扫描任意 Symbol 或宿主私有 scope shape；公开 scoped restriction 安装失败时 preset mount fail closed。后注册/HMR 工具不会进入下一次组装的封闭 catalog，也会被 monotonic execution guard 拒绝。

## 4. Work Agent 隔离

- 两个工具都创建独立 one-shot spawn Session，不复制父 RP transcript。
- child transcript 不含 `mistymoon:turn-voice`、`mistymoon:final-voice-refresh`、Persona 原文或现实 Recall Snapshot。
- child 只见编码 allowlist；RP/Memory 发布删除、最终回复、push/release、部署和委派工具不可见且执行被拒。
- sandbox 不宽于 parent override，approval 为 `never`；权限不足稳定返回 blocked。
- `maxDepth=1`，fork/continuable/control 工具不存在。
- 同一 RP Host 的第二个并发 Work activation 返回 `busy`；第一个结算并 dispose 后才可开始下一次。两个 child 不存在互读输出或直接通信能力。

## 4.1 上游编码层

- Flash 与 Pro Work Agent 都实际加载固定 Anchored Standard，而不是只加载改写后的相似文案。
- 请求顺序固定为 Policy Shield → Anchored → 可选 J-Space → DeepSeek Request Policy。
- Anchored 只决定编码 allowlist 内的 durable tool phase，不覆盖固定模型 route 或治理策略。
- protected DSH safety、permission、Plan、AGENTS 和 skill governance 在上游 Adapter 执行前后都存在；RP Host 不运行这些编码层。
- full/loop 任务可加载固定 J-Space Skill 与 ledger；fast 任务不加载，且 `.jspace/` 不写入用户仓库。
- 每次请求记录 Anchored 与可选 J-Space 的 commit、checksum、启用模式和兼容补丁版本，可从 child Session 重建。

## 4.2 Owner 可见的只读 Work 过程

- 每个已发布 Work child 的 header 含准确 `parentSession`、`origin: subagent`、`delegationDepth: 1` 与实际 Work preset；首步写入标准 one-shot `subagent/descriptor`，publication rollback 不留下可发现 child。
- RP Host 的 DSH rc.7 原生子 Agent 目录在运行中和 dispose 后都能发现该 direct child；点击后通过 `sessions.openSubagent({ parentSessionId, childSessionId, mode: 'one-shot' })` 加载完整、已落日志的可呈现过程。
- 打开的 one-shot child composer 为只读，不提供 prompt、steer、continue、send、interrupt 或再次委派；不展示或声称可取得 provider 未记录的内部 chain-of-thought。
- A 父 Session 不展示 B 的 child。伪造 parent、child 或 mode 时 `subagent.history` fail closed，response 不回显目标 transcript；不得用裸 `session.history` 或 `sessions.open(childSessionId)` 绕过 direct-parent seam。
- 不新增枚举 workspace、mailbox 或全量 transcript 的自定义 HTTP route；列表/card 只保存 exact child reference、状态和 Work Report 摘要，正文事实来源仍是 DSH Session 日志。
- 查看行为不把 child transcript 投影到 RP Host、Persona、Memory、Recall Snapshot 或通用 preset 的 final-reply 路径。

## 5. 模型与 thinking

请求捕获必须逐项证明：

| 请求 | provider | model | reasoningEffort |
| --- | --- | --- | --- |
| RP Host | DSH Web UI 选定的 provider/model（不固定） | DSH Web UI 选定的 provider/model（不固定） | 由所选模型决定 |
| Flash child | `deepseek-official` | `deepseek-v4-flash` | `max` |
专用 Pro child 工具不注册；未来作为正式产品 route 新增时必须独立通过本表同等级验收。Owner 通过通用 selector 手动选择 DSH Pro 只构成 experimental exact pair，不构成资格通过。

任意 experimental exact pair（包括 OpenCode Go）必须捕获实际 provider/model/max header 并单独资格化；direct Flash 的 15/15 不能作为其通过证据。

- 其他 preset/child 的 request 不被 Role Gate 改写。
- Adapter thinking disabled 时三种请求均 fail loud，不发生网络 I/O，不声称已启用。
- tool-call continuation replay 必要 `reasoning_content`；Owner 输出不暴露完整 chain-of-thought。
- provider/model/reasoning/token 用量和 stop reason 可从 DSH 日志审计。

## 6. 委派与结果

- 任务包 schema 拒绝未知字段、越界 workspace、空任务、未授权范围和伪造高风险确认。
- 默认任务包不含完整 transcript、Persona、Recall Snapshot 或其他 Owner 内容。
- completed/blocked/failed/cancelled 与 DSH stop reason 一致。
- RP Host 交付中的 changed files、命令、测试结果、数值和风险与 Work Report 逐字段一致。
- 委派、settlement、Work Report 和最终回复均进入可重建 DSH Session 日志。

## 7. 行为 A/B

固定中性任务覆盖：缺陷修复、跨文件功能、重构、测试补全、代码审查和 Windows 专项。比较：

- Flash-only 首发；未来 route 单独比较；
- high/max；
- 官方 Standard、child small catalog、durable promotion；
- 无 ledger、固定 J-Space Skill Adapter；
- 固定 Anchored Standard 与 MistyMoon Policy Shield 兼容组合。

每个任务/条件至少重复 5 次，记录测试通过率、未授权改动率、事实错误率、请求/工具次数、reasoning/output tokens、延迟、成本和人工纠正次数。实现验收必须在固定 Anchored commit、配置和任务集上复现，并证明加入 Policy Shield 后收益没有消失。J-Space 单独比较，未通过前不成为 fast/full 默认。

## 8. 生命周期与失败

- child run 在成功、失败、取消、超时和 parent dispose 后都被释放。
- restart/compaction 后角色、工具 phase 和请求策略从 durable state 重建。
- malformed Work Report、partial output 和超限结果不标记 completed。
- commit/push/release、永久删除、权限提升和高风险部署无 Owner 确认时不委派。

## 9. 许可证

- Anchored 与可选 J-Space Adapter 都有固定 commit、checksum、来源清单和兼容补丁记录。
- 内置 Anchored Standard 保留 MIT LICENSE/NOTICE。
- J-Space 文件固定 commit，并履行 Apache-2.0 归属、修改声明和 NOTICE。
- `THIRD_PARTY_NOTICES.md` 与实际打包清单一致；缺少所需许可证文件时 publication audit 失败。

## 10. 未来机械检查

~~~powershell
pnpm exec vitest run packages/foundation/tests packages/memory/tests packages/installer/tests
pnpm build
pnpm smoke:built
pnpm audit:publication
git diff --check
~~~

最终实现交付前运行 `pnpm check`，只报告实际执行结果。

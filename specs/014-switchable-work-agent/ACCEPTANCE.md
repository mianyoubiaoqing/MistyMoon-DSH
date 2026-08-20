# 014 验收标准：可切换预设的 Work Agent

本文件验收已于 2026-08-17 获用户批准。Shared Baseline、Preset Resolver、Compatibility Gate、fresh child lifecycle，以及不自动注册的 fixed/governed one-shot provider 工厂已有原型和单元测试；这不表示真实 preset、产品 provider、RP Host 委派工具或切换功能已经可用。

## 1. DSH 接缝与归属

- 不修改 DSH 源码、Profile、安装目录和私有 `agentPresets` 状态。
- 只复制/adapt `subagent-in-process-driver` 所需的最小 MIT 片段；保留 DeepSeek copyright、LICENSE/NOTICE、固定 commit 和差异说明。
- 不复制 continuation manager、fork provider、Host selector 或 DSH persistence。
- 合约测试固定 `99f6f02` 的 public exports；接口漂移时加载失败，不用深路径或私有字段静默兼容。

## 2. 共享基线

- RP Host 与每个 Work Activation 记录同一个 immutable baseline generation/fingerprint。
- baseline canonicalization 对对象键序稳定；任何受治理字段变化都会改变 fingerprint。
- preset switch 不能改变 baseline；baseline migration 是独立、显式操作。
- baseline、manifest 和事件不含绝对本机路径、凭据、Persona、Memory 或 transcript 内容。
- child role policy 对 target preset 工具取交集；sandbox 不放宽，approval 恒为 `never`，depth 恒不超过 `1`。

## 3. Spawn-time preset selection

- RP Host 使用一个 preset，fresh Work child 可在 creation transaction 内挂载另一个注册的 Work Preset。
- 每个 Work profile 对应一个完整、版本化的 DSH preset id；v1 不运行时叠加多个 preset。
- child header 的 `agentPreset` 与实际挂载 preset 一致；不再错误记录 parent preset。
- child 首个 `request/header`、prompt section fingerprint 和 tool catalog 与 activation descriptor 一致。
- mount、manifest 或 compatibility 失败时 child 不发布，所有 scoped contribution 被回滚。
- Coding 工具位于 child 的 standing ancestor，exact child scope restriction 能过滤它们；exact child 自有工具仅限经过独立 allowlist 审计的 report/structured-output 等能力。
- 任意路径、未知 profile、checksum 不符和许可证不就绪均被拒绝。
- 每个成功 publication 的 child 可由父会话的 rc.7 原生目录发现，并用 exact `parentSessionId + childSessionId + one-shot` 地址只读打开；profile revision 变化不重绑或改写旧 child。
- forged parent/child/mode、普通 preset 或其他 RP Host 不能借目录或自定义列表读取不属于该 direct parent 的 child；不新增全 workspace transcript API。

## 4. 固定上游编码层

- `anchored-standard` 实际加载固定 Anchored Standard Adapter。
- `anchored-standard-jspace` 在上述组合后实际加载固定 J-Space Skill/Ledger。
- composition 顺序为 Policy Shield → Anchored → 可选 J-Space → DeepSeek Request Policy。
- target 使用 complete persona、抑制 runtime context 或清空 protected sections 时 compatibility gate 拒绝挂载。
- 每次 activation 记录上游 commit、checksum、delivery mode 和兼容补丁版本。

## 5. 角色与隐私隔离

- child 是 fresh spawn，不复制 RP Host transcript 或 completed-turn prefix。
- delegated `source.kind=user` 且 depth 非零时不生成 Foundation voice/final refresh，不触发 Memory observe/recall/candidate。
- child transcript 不含 Persona、关系摘要、现实 Recall Snapshot、Character Scene 私密内容或 Campaign 未授权分支。
- RP Host 没有编码执行或 browser side-effect 工具，但有只读 `web_search` / `web_fetch` / `read` / `grep` / `glob`；Work child 没有 RP/Memory mutation、final reply、再次委派、push/release 或高风险部署工具。
- schema lookup、Code Mode SDK 和直接 execution 都执行同一 restriction；sandbox/approval 另有权限测试。
- 同一 logical agent 并发 submit 的第二个请求稳定返回 `busy`；不同 child 无互读输出/通信通道，共享 workspace 写入不并行。

## 6. 模型与 route

- Flash Activation 捕获 `deepseek-official / deepseek-v4-flash / max`。
- Flash-only 首发不注册专用 Pro Activation 工具；未来正式新增时单独捕获其 DSH provider/model/reasoning header。通用 selector 手动选择 Pro 仍按 experimental exact pair 验收。
- 设置页从 DSH live catalog 读取可解析 `max` 的模型；默认 direct Flash，非默认 exact pair 需要 Owner 保存确认，并只作用于之后的 fresh activation。
- 模型设置只保存 provider/model 引用、固定 reasoning、qualification 和 revision；不保存凭据或提供商配置。实际 request header 必须等于所选 exact tuple，失败时无 fallback。
- target preset 不能把请求改到 baseline allowlist 外。
- thinking disabled、model unavailable 或 max 被 policy 拒绝时在首次可判断点 fail loud，不静默降级。
- 日志记录 reasoning effort 与 token 统计，但不向用户输出完整 chain-of-thought。

## 7. Logical profile switch admission

- 只在没有 active run，且上一 activation 已有 terminal result、完整 `turn/end` 并完成 dispose 时接受 switch。
- 存在未结算 tool call、Task、structured capture、result 或 finalization 时返回 `busy`。
- switch 使用 `requestId` 幂等和 `expectedRevision` 乐观并发；过期 revision 不改变 profile，也不创建 child。
- Work Agent 自身不能直接调用 switch；capability/cost 提升缺 Owner confirmation 时返回 `confirmation-required`。
- 绝不对已有 turn 的 Session 调用 `agentPresets.recompose()`。
- committed switch 只影响下一次 fresh one-shot activation，不被描述为 native continuable preset switch。

## 8. Profile revision 与恢复

- parent commit 前必须解析 target 完整 preset、核对 manifest/compatibility 并完成所需 Owner confirmation。
- 只有 requested、没有 committed 时恢复旧 profile revision；不得把 intent 当成有效选择。
- committed 后尚未创建 child 时，新 profile 已选定，下一次 submit 创建 fresh Session。
- activation 启动后崩溃时按 DSH repair 得到 interrupted/error；未经用户确认不重放可能已有副作用的任务。
- child header、one-shot descriptor、baseline 或 preset fingerprint 不一致时进入 `blocked-corrupt`，不回退旧 preset 冒充成功。
- 重启后缺 target preset/baseline fingerprint 时进入 `blocked-incompatible`，保留可诊断 metadata。
- 同一 `requestId` 在重试、崩溃恢复和并发调用中最多产生一个 committed profile revision。

## 9. Work Handoff

- 新 activation 不复制旧 transcript，只接收 `WorkHandoffV1` 和下一项任务。
- Work child 的 completed 自由文本必须先通过严格 `WorkReportV1` 单 text-block JSON 校验；DSH reasoning blocks 在 completed 与 partial 结果交付前一律丢弃，未知字段、Markdown fence、多 text block、其他非文本、超限字段和 malformed JSON 都转为中性 error，原始载荷不回显。
- handoff 只能从 completed Work Report、J-Space ledger 和 DSH events 构造；invalid report 不能生成 handoff。
- handoff 作为真实 model-visible user message 写入新 child Session，provider request 可从日志重建。
- handoff schema 拒绝未知字段、越界路径、凭据形态和 RP/Memory payload。
- goal、constraints、changed files、checks、verified/open/next 与来源逐字段一致。

## 10. 生命周期与失败

- 创建前取消、publication 后取消、运行中取消、mount 失败、模型错误、max tokens、parent dispose 均有确定 stop reason。
- `dispose()` 幂等，最终等待 result 与 child quiescence；one-shot 完成后不保留 resident activation。
- parent dispose 取消当前 run 并等待 child release；所有 timer、listener、scope 和 handle 均有 disposer。
- process restart 的 logical profile projection 与 authoritative parent event fold 结果一致。
- 不复制 DSH continuation manager，不伪造 `mode: continuable` descriptor。

## 11. 质量与发布门

- 用中性任务重复比较 `anchored-standard`、J-Space profile、已启用 route 和 reasoning effort；沿用 011 的质量/安全指标。
- preset switch 前后的技术事实、文件改动和测试结果不因 RP Host 外围语气发生改变。
- built Cordis smoke 覆盖 provider 注册、preset mount、spawn、profile switch intent/commit recovery、crash repair 和 dispose。
- `pnpm check` 与 `pnpm audit:publication` 通过；打包清单不含 Routing Suite、真实角色卡、Memory、Session、日志、凭据或本机路径。

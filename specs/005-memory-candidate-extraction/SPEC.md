# 005：Memory Candidate Extraction

状态：2026-08-20 已按 `002-p0-memory-program` 完成实现与机械验收。本段只交付 C，不包含冲突替代、候选编辑、管理页、召回升级或生命周期。

## 结果

Owner 顶层 turn 完成回复后，Memory 可调用一个已注册的 `CandidateExtractionProvider`，把当前 turn 中经 Owner Eligibility 认证的消息作为唯一证据。Provider 只能返回不可信候选草稿；Memory 负责严格校验、可信 scope 绑定、来源选择和原子写入。所有结果保持 `pending`，永不自动批准或参与召回。

## 公共边界

- `CandidateExtractionProvider` 接收版本化请求、可信 `MemoryAccessContextV1`、DSH Session/turn 标识及允许的 Owner evidence。
- Provider 返回最多八条严格草稿及执行 receipt。草稿只能引用输入中的 source message ID，不能声明 Owner、authority 或 scope。
- 本地确定性 Provider 使用版本化 local receipt；任何模型型 Provider 必须返回可定位其实际模型可见输入/输出的 DSH Session receipt。
- `CompanionMemoryArchive.proposeExtracted()` 按一条 source message 原子写入一个 Observation 和该来源的全部候选；相同来源和相同规范化结果幂等，不同结果 fail closed。
- Memory 在 `agent/turn-stopping` 后处理已经生成的回复。Provider 不可用、超时、取消、schema 无效或档案不可写时不产生半批次，也不使 Owner turn 失败。

## 数据与隐私

- Work child、delegated prompt、未认证消息和非顶层 Agent 均不能触发抽取。
- Provider 不接收 Persona、关系档案、Recall Snapshot、Work transcript 或全会话历史。
- Candidate 保留 provider/version/receipt 与真实 source message ID；正文仍是私有数据，不进入日志、测试或诊断。
- 默认没有外部 Provider；本段不发起远端请求。

## 允许修改

`packages/memory/**`、必要的 bundle 配置/冒烟、README/架构/HANDOFF，以及本 Spec/Acceptance。不得修改 DSH 源码或读取真实档案。

## 回滚

移除 Provider 注册或关闭 extraction 即停止新候选；既有 pending candidate 继续由档案治理，不做物理删除。

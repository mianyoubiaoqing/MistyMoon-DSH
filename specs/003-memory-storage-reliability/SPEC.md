# 003：记忆存储可靠性基础

状态：2026-08-18 Owner 已批准在下一会话以中性 fixture 实施。本叶子 Spec 只覆盖 P0 Memory Program 的段 A；仍不得在本段混入自动候选提取、冲突检测、管理页、融合召回或记忆整合，也不得迁移或恢复真实档案。

诊断基线：MistyMoon `dd4506e7ffe9ac7902b23c9387b1cc82b598e393`；DSH 官方 `master` `47f943859bef60e4160492346772ded9b24f765a`。当前 MistyMoon 与 DSH 工作区均有用户所有修改，不得覆盖、清理或混入实现。

## 问题陈述

Memory 当前把事实、候选和决定直接追加到一个 v1 JSONL 文件。单个进程内的 `#writes` Promise 能排序同一 Archive 对象的写入，但不能协调两个 DSH/MistyMoon 进程、两个 Archive 实例或崩溃后的半条记录。Candidate approval 需要同时追加 confirmed memory 和 resolution；当前格式依赖多行文本完整落盘，缺少事务重放单位。

自动候选提取会增加后台写入和重试。在引入它之前，档案需要版本化事务格式、跨进程单写者、写前重读、durability checkpoint、显式迁移、可诊断隔离和人工确认恢复。

## 实际行为与预期行为

### 实际行为

- `openMemoryArchive()` 逐行解析 v1；任一损坏行使整个打开失败，没有结构化 inspection 或恢复计划。
- Mutations 直接 `appendFile()`；`#writes` 只保护一个对象实例。
- 两个实例从同一旧快照出发时可以分别接受同一 `sourceMessageId`，之后重启才因重复来源失败。
- Candidate approval 的 memory 和 resolution 是两个逻辑事件，没有单一事务 envelope。
- 没有显式格式迁移、迁移前备份、版本回滚路径或跨进程 lock timeout。

### 预期行为

- 新空档案使用 v2 transactional JSONL；每个逻辑 mutation 对应一条 transaction record，内部可含多个 domain events。
- 每次 mutation 先取得相邻档案的 exclusive lease，再从磁盘重读、校验、重放、执行幂等/冲突判断、追加一个 transaction、flush durability，最后发布新的内存 snapshot。
- 两个进程不能提交相互不知道的状态；同一幂等来源返回既有结果，不同 mutation 按 lease 顺序重放。
- v1 档案只能经显式 plan/apply 迁移；迁移先生成 owner-private exact backup，再以同卷临时文件、flush 和原子替换发布 v2。
- 损坏档案进入 quarantine：禁止 recall 和 mutation，但可通过无敏感正文的 inspection 查看问题并生成 recovery plan。
- 自动恢复禁止。只有 trailing partial transaction 可在 exact backup 后按 plan token 明确裁剪；interior corruption、hash mismatch 或缺失记录必须从已知备份恢复或由用户决定。

## 可重复的最小复现

### 跨实例重复来源

1. 对同一路径同时 `openMemoryArchive()` 两次。
2. 两个实例在 barrier 后用同一 `sourceMessageId` 提交不同 candidate/content。
3. 当前两个 mutation 都可能成功；重开时才报告 duplicate source。

新期望：只有第一个 transaction 成功；第二个在取得 lease 后重读并按幂等规则返回同结果或以明确 source conflict 失败，档案始终可重开。

### 审核事务被截断

在 candidate approval 写入 confirmed memory 与 resolution 之间注入 partial write/crash。当前格式可能留下没有 resolution 的 memory 或半行。新格式只重放完整、digest 正确的一条 approval transaction；partial tail 不应用任何内部 event，并使档案 quarantine。

### 损坏恢复

向有效档案末尾追加半条 JSON，再启动。当前只有普通 load error。新实现返回 `trailing-partial-transaction` inspection，保持最后完整 snapshot 可识别但不可用于 recall，只有经过 plan/apply、exact digest matching 和备份后才允许裁剪。

## 根因与证据

### 已确认事实

1. `packages/memory/src/index.ts` 使用 `appendFile()` 写入 JSONL。
2. 写入排序状态是 `JsonlMemoryArchive` 实例私有的 `#writes` Promise，不是文件或进程级 lease。
3. Loader 遇到任一 JSON/record 错误即抛出，没有 issue taxonomy 或 repair plan。
4. Candidate approval 一次 append 两个换行分隔 JSON objects；格式没有 transaction record。
5. 当前 format 只有每条 record 的 `schemaVersion: 1`，没有 archive header、transaction digest 或 hash chain。
6. Settings UI 通过 `CompanionMemoryArchive` Interface 审核候选，没有必要直接访问文件。

### 有证据支持的推断

- 单进程测试无法证明多进程安全；自动提取会扩大并发窗口。
- 事务 envelope 能保证 logical mutation 的 all-or-none replay，但文件系统仍可能产生 partial tail，因此还需要 quarantine/recovery。
- Hash chain 可发现 transaction 修改、删除和重排；它不证明操作者身份，也不替代备份。

### 尚未确认

- 最终 lease Adapter 使用哪个维护中的 MIT 依赖；实施前必须核对 Node 版本、Windows 行为、维护状态和许可证，不得自行手写不可靠 PID lock。
- Windows/文件系统是否支持目录 flush；Implementation 必须通过 fault-injection 和 Windows CI 证明承诺，无法证明的 durability 等级须停止并提交问题。
- 用户希望维护入口最终保留 CLI 还是由后续管理页复用同一 Interface；本段只要求 CLI Consumer。

## 问题分类

| 分类 | 结论 |
| --- | --- |
| MistyMoon 产品逻辑 | 主要：档案 durability 与恢复语义属于 Memory |
| 插件组合或加载顺序 | 非根因；Bundle 只传默认配置 |
| DSH 接口使用错误 | 排除；不需要修改 Agent Loop |
| 配置或安装问题 | 非根因；迁移部署需要显式步骤 |
| 数据格式或迁移问题 | 主要 |
| UI/Host/RPC 问题 | 排除；本段无新 UI |
| 上游 DSH 缺陷 | 排除 |

## 目标与非目标

### 目标

- 一个 deep `MemoryArchiveStorage` Module 隐藏格式、lease、重放、事务、flush、inspection、migration 和 recovery。
- 保持 Memory 的事实/候选/决定治理语义。
- 新写入具备跨进程 serializable mutation order 与 logical transaction replay。
- 所有破坏性维护操作先 dry-run、绑定 exact digest、创建 backup，并要求显式 apply。
- 故障不影响 DSH Coding/工具/权限；Memory fail closed，诊断不泄露正文。

### 非目标

- 不实现自动提取、冲突检测、候选编辑/合并、管理页面、BM25/PageIndex/图召回或生命周期。
- 不改变候选批准规则、visibility、recall ranking 或 Persona。
- 不永久物理删除审计事件。
- 不自动修复 interior corruption，不依赖云备份。
- 不修改 DSH 源码、Session 格式或 preset/Profile。

## Module、Interface、seam 与 Adapter

### Module：`MemoryArchiveStorage`

建议 Interface 语义如下，精确 TypeScript 名称可调整：

```ts
interface MemoryArchiveStorage {
  open(): Promise<ArchiveOpenResult>
  transact(command: MemoryCommand): Promise<MemoryCommit>
  inspect(): Promise<ArchiveInspection>
  planMaintenance(request: MaintenanceRequest): Promise<MaintenancePlan>
  applyMaintenance(plan: ApprovedMaintenancePlan): Promise<MaintenanceResult>
}
```

Interface 必须包含调用者需要知道的状态：`ready | migration-required | quarantined`、可重试/不可重试错误、lease timeout、plan digest/expiry 和 durability completion。它不得暴露 JSONL line、lockfile path、临时文件名或内部 maps。

现有 `CompanionMemoryArchive` 成为治理 Consumer：读取 immutable snapshot，mutation 转为 `MemoryCommand`，不再自行 append/rollback。Settings UI 和工具仍只调用 `CompanionMemoryArchive`。

### Storage capability seam

- **Service Definition**：Memory 包内的 `MemoryArchiveStorage` Interface 与 transaction/inspection vocabulary。
- **Service Provider**：private v2 transactional JSONL Adapter。
- **Consumers**：`CompanionMemoryArchive`；只读/显式维护 CLI。
- **Internal Adapter seam**：`ArchiveLease`，生产文件 lease Adapter与 deterministic fake/fault Adapter共享 Interface。Lease implementation 不泄漏到治理调用者。

Bundle 只组合路径和 validated defaults。Settings UI 不读取 archive、backup 或 lock 文件。

## v2 数据格式

- 文件第一条为 v2 header，至少记录 `schemaVersion: 2`、archive id、创建时间和完整性算法版本。
- 后续每行恰好一个 transaction envelope：transaction id、时间、previous digest、非空 domain events、digest。
- Digest 使用固定的 canonical serialization；算法和 canonicalization version 是协议常量，不是 tunable。
- 一个 mutation 的全部 domain events位于同一 envelope。Candidate approval 的 confirmed record 与 resolution 必须同 transaction。
- Loader 先验证 JSON、大小、header、transaction schema、domain invariants、previous digest 与 digest，再发布 snapshot。
- Partial/incomplete line、unknown required event、hash mismatch、missing link、duplicate id/source 或非法 state transition 均不得部分重放。
- V1 exact bytes 在迁移前备份；v2 不要求旧 runtime 可写。旧 runtime 遇到 v2 应明确拒绝，而不是猜测。

## Mutation 数据流

```text
Consumer command
  -> validate typed command
  -> acquire exclusive archive lease (bounded timeout)
  -> reread bytes and validate full v2 chain
  -> fold authoritative current state
  -> apply idempotency/domain transition in memory
  -> serialize one transaction envelope
  -> append complete bytes
  -> flush file durability checkpoint
  -> publish immutable snapshot/commit result
  -> release lease
```

写入或 flush 失败时不得发布新 snapshot。释放 lease 失败必须报告但不能把未提交状态伪装为成功。进程 dispose 等待自己已开始的 commit 到达 bounded terminal state；不开始新 commit。

## Inspection、迁移和恢复

维护 Consumer 必须支持两步协议：

1. `inspect/plan` 只读，返回 archive 状态、大小、格式、event/transaction counts、last valid offset、issue codes、预计动作、backup requirement、content-free digest 与一次性 plan token。
2. `apply` 必须携带 plan token 与 expected digest；重新取得 lease、重读并验证完全相同后才执行。状态变化则拒绝并要求重新 plan。

V1 migration：exact backup → 写同卷 temp v2 → flush temp → 原子 replace → 必要的 directory durability step → 重开验证。任一步失败保留 v1 source 或 quarantine，不能同时声称两者成功。

Trailing recovery：exact backup 后只裁剪最后完整 transaction 之后的无效 tail，再重开验证。Interior corruption 只给出 restore-from-backup plan，不自动跳过。

## 配置

Deployment-varying值必须是 validated Cordis Config，包括：lease acquire timeout、stale/compromise policy、最大 archive bytes、最大 transaction bytes、maintenance plan expiry和 backup retention上限。安全协议常量（schema version、digest algorithm、canonicalization）固定。

配置错误 load-time fail loud。Runtime settings UI 不在本段新增这些高级项；Bundle 可提供保守 defaults，不拥有规则。

## 持久化与迁移影响

- 这是 breaking Memory archive format change，但不改变 DSH session、Persona、Character Card 或 Settings document。
- Existing v1 archive 打开为 `migration-required`：可 inspection/plan，不允许 recall 或 mutation，避免在未经批准格式上继续写。
- Empty/nonexistent path 可直接创建 v2。
- Migration 不自动运行。真实 archive 只有用户明确授权 maintenance apply 后才能改变。
- Backup 位于私有 Memory home，权限不宽于 source；文件名不含 persona/memory正文。

## 隐私、安全与失败行为

- Inspection、lock、transaction metadata、CLI stdout、tests和报告不得输出 memory content。
- Backup、temp、lock 与 archive 都属于 owner-private data，不进入 Git/publication。
- Quarantine 时 recall 返回明确 unavailable 状态；不得使用 stale snapshot、template或跳过坏行继续召回。
- Memory failure不得阻断 DSH Coding turn：pre-step不注入 recall，并产生中性本机诊断；mutation tool/RPC明确失败。
- 不根据 PID 单独删除 stale lock，不在无法证明 owner时强制夺锁。
- Maintenance apply 属高风险本地状态变化，必须显式授权；本 Spec 不授权对真实数据运行。

## 兼容性

- Windows 是必须支持的平台；并发、rename/replace、flush、abort和dispose均需测试。
- 只使用 DSH 最新公开 Cordis/Memory组合点；不新增 DSH event。
- Existing memory tools与candidate Settings RPC保持语义；允许其内部等待 lease。
- Legacy SQLite migration先导入到 ready v2 archive；不得直接写 v1。
- Publication audit必须排除 archive、backup、temp、lock、maintenance plan和诊断转储。

## 允许修改

- `packages/memory/src/index.ts`（只收敛调用；大部分 storage implementation 应拆到内部文件）
- `packages/memory/src/storage/**` 或同职责内部目录
- `packages/memory/src/maintenance.ts`
- `packages/memory/tests/**`
- `packages/memory/package.json`
- `scripts/memory-maintenance.ts`、相关根 `package.json` script
- 仅必要的 `pnpm-lock.yaml` importer/dependency变化
- `packages/installer/tests/**`、`scripts/smoke-built.mjs`
- Bundle 的 Memory Config defaults及其组合测试，不增加业务逻辑
- `README.md`、`packages/memory/README.md`、`docs/architecture.md`、`AGENTS.md` 的直接相关事实

## 明确禁止修改

- `<DSH_REPO>` 的任何文件或 Git 状态
- `packages/foundation/**`、`packages/settings-ui/**`、Persona、Importer 和 Character Card
- 自动候选提取、冲突检测、候选编辑/合并、管理页、召回算法、归档/衰减
- 用户真实 Memory home、archive、backup、session或日志
- 无关依赖升级、重构、commit、push、PR、安装、迁移、发布或远端操作
- `.research/**` 与已批准的 Spec

## 分段实施与提交边界

即使本叶子获批，Implementation 也按三个小提交组织：

1. v2 vocabulary、pure parser/fold、inspection和v1 migration planner；不接 runtime writer。
2. Lease + transactional writer +现有 Archive Consumer接入；不实现 recovery apply。
3. Maintenance apply/recovery CLI、组合/built smoke和文档。

每一步必须保持 tests green，禁止把下一 P0 段混入。若无法保持可运行中间状态，应在编码前提交替代拆分方案。

## 部署与回滚

先用中性临时 v1 fixture演练 plan/apply和回滚。真实部署必须先停止所有 MistyMoon writers、inspect、创建并验证 backup、迁移、重开验证，再启动一个 writer；不得滚动混跑 v1/v2 runtime。

回滚需要停止新 runtime，使用 maintenance工具验证并恢复 exact v1 backup，再安装旧版本。旧 runtime不能直接打开已写入 v2 transaction的档案。合并、安装、真实迁移和发布均由用户决定。

## 已确认的执行决策

1. 现有 v1 档案在显式迁移前 Memory fail closed，DSH Coding 继续运行。
2. 本段维护入口只提供本机 CLI；专用 UI 留到段 F。
3. Interior corruption 只能从已知备份恢复，不自动跳过或猜测修复。
4. 下一会话只操作中性临时 fixture；真实部署前仍由 Owner 选择 backup 位置/保留期并单独授权 maintenance apply。

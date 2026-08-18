# 003 验收标准：记忆存储可靠性

除真实数据迁移与用户部署决定外，全部使用中性临时目录机械验证。不得读取用户 Memory home。

## 1. 修复前稳定失败的回归

### 1.1 跨实例重复来源

两个 Archive 实例从同一空 v1 fixture打开，barrier后以相同 source提交不同内容。当前实现两个 Promise都可能成功，重开才失败。新实现必须在第二个取得lease后重读：完全同一 command幂等返回同commit；不同内容以稳定 source conflict失败。重开始终ready。

### 1.2 Candidate approval partial tail

在 approval transaction的每个写入/fsync边界注入crash。任一重开结果只能是：完整approval已应用，或零个approval内部event已应用且archive quarantined/保持旧snapshot；不得出现confirmed memory没有resolution。

### 1.3 损坏分类

构造 trailing half JSON、interior invalid JSON、digest mismatch、broken previous digest、duplicate id/source和unknown required event。当前只给普通load error；新 inspection返回不同稳定issue code，不含测试正文。

## 2. Pure format tests

- Empty path创建valid v2 header。
- 每个mutation序列化为一行transaction；approval在一个envelope中含两个domain events。
- Canonical serialization在key insertion order不同的等价input上产生同digest。
- Hash chain检测修改、删除、重排和截断。
- Parser按配置拒绝oversized archive/transaction，且不分配无限buffer。
- Fold覆盖confirmed、forgotten、superseded、candidate、approval/rejection和legacy import既有语义。
- 未知required event fail；明确允许的未来ignorable metadata只能按批准协议跳过，不能自行猜测。

## 3. Lease 与事务 tests

- 两个进程/worker或等价真实文件Adapter并发写100次，最终transaction数量、id/source和fold一致，无lost update。
- Mutation在lease内重读；不得以构造时snapshot直接写。
- Lease timeout稳定失败，不改变文件或内存snapshot。
- Compromised/stale lease不按PID单独强拆；策略与错误可观察。
- Append失败、partial write、flush失败、release失败、abort和dispose各有fault injection。
- Commit只有在完整append+flush后返回success；失败不发布新snapshot。
- 同一idempotency command重试返回原commit，不新增transaction。
- 两个不同archive路径不互相阻塞；同路径串行。

## 4. Migration tests

- V1 valid fixture得到`migration-required`，可inspection但recall/mutation fail closed。
- Plan包含source digest、counts、预计动作、backup requirement和opaque token，不含正文。
- Apply缺token、token过期、digest变化、lease timeout或backup失败均拒绝且source byte-identical。
- Successful apply创建exact v1 backup，通过temp+flush+replace发布v2，fold结果与v1完全等价。
- Migration中每个fault point后，source要么仍是完整v1，要么是完整可重开的v2；不能是混合格式。
- Empty archive无需迁移直接v2；legacy SQLite只导入ready v2。
- Older runtime对v2明确拒绝的兼容测试保留，rollback文档指向exact backup。

## 5. Quarantine 与 recovery tests

- 任一corruption打开为quarantined；recall不注入stale snapshot，mutation拒绝，inspection仍可用。
- Trailing partial plan只允许裁剪last valid offset之后bytes；apply前创建exact backup并复核digest。
- Interior corruption不生成truncate/skip action，只生成restore-required。
- Recovery token对其他path/generation/digest不可重放。
- Recovery成功后完整重开并验证chain；失败保持source或backup可恢复。
- CLI stdout/stderr只有path、counts、offset、digest、issue code和action，不含memory content。

## 6. Existing behavior compatibility

- Explicit remember、list、forget、replace、candidate propose/list/approve/reject和recall既有tests继续通过v2 Adapter。
- Settings candidate list/approve/reject RPC语义不变。
- Pre-step只在archive ready时投影confirmed recall；migration-required/quarantine时不投影并不中断Coding。
- Pending/rejected/forgotten/superseded仍不召回。
- Two Agent/contexts共享同一archive时不串owner、source或commit。

## 7. 插件组合与 built smoke

Cordis组合断言：

- Memory提供一个`CompanionMemoryArchive`给Tools/Settings Consumer；storage implementation不泄漏到Bundle。
- Bundle只传validated defaults。
- Dispose等待bounded in-flight commit并释放lease；reload无重复Provider/listener。
- Foundation、Settings独立加载不访问storage文件。

至少运行：

```powershell
pnpm exec vitest run packages/memory/tests packages/settings-ui/tests/settings.spec.ts packages/installer/tests/root-bundle.spec.ts
pnpm build
pnpm smoke:built
```

Built smoke覆盖new v2、v1 migration-required、concurrent mutation、quarantine无recall和clean dispose。

## 8. CLI与Windows冒烟

在中性temp fixture执行inspect、plan migrate、apply migrate、plan trailing recovery、apply recovery和rollback rehearsal。若仓库有Windows CI，新增同盘rename/replace、lease contention和打开句柄场景；不得以Linux-only mock替代Windows承诺。

CLI必须默认read-only；任何apply都需要显式subcommand、plan token和expected digest，不允许`--force`绕过。

## 9. 隐私发布审计

```powershell
pnpm audit:publication
git diff --check
git status --short
```

Publication候选不得含`*.jsonl`、backup、lock、temp、maintenance plan、真实路径或诊断转储。Fixture只用中性生成内容。

## 10. 最终门禁

```powershell
pnpm check
```

实施Agent只报告实际命令。Codex独立验收重跑跨实例、fault matrix、migration、quarantine/recovery、Settings compatibility、built smoke和publication audit。

## 11. 用户手工 Review

用户仅对复制的中性fixture操作：

1. Inspect v1，确认不展示正文。
2. Plan/apply migration，确认backup存在且v2可正常remember/recall。
3. 制造trailing partial，确认Memory停用但Coding仍工作。
4. Plan/apply recovery，确认需二次显式动作且恢复后正常。
5. 演练停止runtime、恢复v1 backup和旧版本拒绝v2。

本阶段不得对真实档案执行迁移或恢复，除非用户在验收之外另行明确授权。

## 12. 验收失败条件

- 仍由Archive对象直接`appendFile()`且没有跨进程lease/re-read；
- logical mutation跨多个独立transaction；
- success在flush前返回，或失败后内存snapshot领先磁盘；
- 自动迁移、自动truncate、跳过interior corruption或`--force`；
- quarantine仍召回stale内容；
- lock/diagnostic/UI/report泄露memory正文；
- Settings UI直接访问文件；
- 实现任何段B–I功能；
- 修改DSH、私有数据、未批准Spec或出现未声明偏差。

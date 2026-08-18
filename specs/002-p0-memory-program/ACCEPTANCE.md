# 002 验收标准：P0 Memory Program

本文件只验收分段治理，不验收产品代码。

## 机械检查

- `specs/002-p0-memory-program/` 的公开记录只包含 `SPEC.md` 和 `ACCEPTANCE.md`。
- A–I 每段都有唯一主要结果、依赖和明确不包含项。
- 每段都要求独立用户批准、DSH 实施、Codex 验收和用户合并决定。
- Program 没有授权修改 `packages/**` 或 DSH。
- 文档不含真实 persona、memory、card、credential、session、日志或本机私有数据。

建议检查：

```powershell
rg -n "^\| [A-I] \|" specs/002-p0-memory-program/SPEC.md
rg -n "不授权|独立.*批准|不得修改 DSH|私有" specs/002-p0-memory-program
git diff --check
git status --short
```

预期 A–I 恰好九行；三份文档无尾随空白，Git 状态中只有用户已有修改和 Spec 文件。

## 叶子 Spec 进入条件

任何叶子 Spec 开始实施前必须机械确认：

- 编号未被占用；
- 状态受 2026-08-18 Memory 完成授权覆盖，或另有用户批准，而非待审；
- 列出允许与禁止文件；
- 给出回归/特性测试、组合测试、built smoke、隐私审计和最终门禁；
- 说明模型可见内容如何写入 DSH 会话日志；
- 说明格式、迁移、失败和回滚；
- 不把后续段的验收条件算作当前段完成。

## Program 验收失败条件

- 一个实施授权覆盖两个以上主要结果；
- 自动提取先于存储可靠性；
- 自动提取或召回升级先于 trusted Owner/scope/Observation 领域边界；
- `confidential` 在没有可信 Owner 明确意图与通道披露策略时进入自动召回；
- UI 直接读取 Memory 文件或拥有审核规则；
- Provider 可以自动批准候选、改变 owner 或绕过来源；
- 任一段需要修改 DSH 源码；
- 以一个大改动或一次总验收替代逐段 Spec、测试和 Codex 验收边界；
- 未声明偏差或私密数据进入 Spec/报告。

## 用户 Review

Owner 已确认按依赖顺序彻底实现 Memory、保持独立可验收边界，并把外部 Provider 限为默认关闭的 shadow/opt-in。为落实已接受的 `012` 目标架构，本 Program 在 Storage 之后增加独立 Scoped Records 阶段；Program 授权覆盖普通本地实现，但不覆盖真实数据维护、远端启用、永久删除、部署或 Git 发布动作。

# 015：Owner Eligibility 共享阻断门

状态：2026-08-17 已完成并通过完整 `pnpm check`。它不注册 RP/Work preset，不修改 DSH 源码、Profile 或客户端。

## 目标

Foundation 与 Memory 必须通过同一个 `OwnerEligibilityService` 判断 Owner 行为，不再把所有 `source.kind=user` 消息都当作 Owner。规范结果同时满足：

~~~text
source.kind == user
AND canonical delegationDepth == 0
AND authenticated owner identity matches the session/channel authority
~~~

任一条件不能证明时 fail closed：不读取 Persona、不生成 turn voice/final refresh、不观察或召回 Companion Reality Memory，也不允许记忆治理工具执行。

## 当前认证入口

DSH rc.7 Host ApiProxy 接受浏览器 prompt 后，会把请求的 `rpcId` 持久化到 `user/message.source`；原生 one-shot child 的 delegation prompt 只有 `{ kind: 'user' }`。MistyMoon 当前 Web bundle 使用一个显式的 `local-dsh-host-rpc` 单 Owner authority：

- 只接受 `kind=user` 且带非空 `rpcId` 的 Host prompt；普通 user 标签、prompt 自称、工具参数和历史父消息都不是身份证明；
- bundle 配置提供中性 owner id，不把真实账号、路径或凭据写入仓库；
- DSH 顶层 header 中 absent delegation depth 按其公开合同规范化为 `0`；显式非零 depth 一律拒绝；
- `rpcId`、message id、session id 和 owner id 共同绑定一次判断，不能把另一 Session 的证据重放到当前消息；
- 当前 turn 判断只读取最后一个尚未结束的 `turn/start` 之后的 durable user messages，fork/seed 中旧 Owner 消息不能授权 child 工具。

该 authority 只适用于当前默认 loopback Web 部署。Headless、QQ/NapCat、手机和其他远程 Channel 必须实现自己的认证 authority；没有 authority 时功能安全关闭，不回退为“所有 user 都是 Owner”。

## 模块边界

新增独立 `packages/identity`：

- 纯 `OwnerEligibilityPolicy` 校验 source、depth 和绑定的身份 evidence；
- DSH Adapter 从 immutable Session header、durable message source 和当前 turn 构造 evidence；
- Cordis 只提供 `mistymoonOwnerEligibility` 窄服务。

Foundation 与 Memory 依赖 `@mistymoon/dsh-identity` 的公共接口，不相互依赖，也不复制 `rpcId`、depth 或 current-turn folding。Identity 不读取 Persona、Memory 档案、DSH Home 或 Profile。

## 公共结果

~~~ts
type OwnerEligibilityDecisionV1 =
  | { version: 1; eligible: true; ownerId: string; authority: string }
  | {
      version: 1
      eligible: false
      reason:
        | 'not-user-source'
        | 'delegated-session'
        | 'delegation-depth-missing'
        | 'delegation-depth-invalid'
        | 'identity-missing'
        | 'identity-mismatch'
        | 'no-active-owner-turn'
    }
~~~

调用方只按 `eligible` 分支，不根据自然语言猜测，也不把 Owner id/evidence 送入模型。

## 验收

- Host RPC user + top-level Session +匹配 owner evidence 才 eligible。
- child 的 `source.kind=user` + `delegationDepth=1` 返回 `delegated-session`。
- 顶层但无 `rpcId`、plugin/tool/model source、身份不匹配均 fail closed。
- Foundation child 不产生 `mistymoon:turn-voice` 或 final refresh。
- Memory child 不 observe/recall，且所有 Memory 工具返回拒绝并不改变档案。
- current-turn 授权不读取已结束 turn 或 seed 中的 Owner 消息。
- DSH Host `rpcId` 与 Session header 足以从 durable log 重建判断；无私有 payload 或绝对路径进入事件。
- `pnpm check`、built smoke 与 `pnpm audit:publication` 通过。

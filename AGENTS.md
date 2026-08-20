# MistyMoon 代码规范与 Agent 协作约定

本仓库是 DeepSeek Harness（DSH）的外置插件套件，以角色扮演（RP）和长期陪伴为产品核心。所有开发者和自动化 Agent 在修改前都必须阅读本文件、`README.md` 以及受影响包的说明。

## 产品不变量

- MistyMoon 负责人格、关系、长期记忆和陪伴体验；DSH 负责 Agent Runtime、会话、工具、权限、模型路由和 Web 宿主。
- 新行为必须通过 MistyMoon 插件或 DSH 已公开的扩展点实现。不得为解决本套件问题私自修改 DSH 源码、客户端或用户 Profile。
- 任何送入模型的人格或记忆都必须能从 DSH 会话日志重建。长期档案是事实来源之一，但不能绕过 DSH 的模型可见日志。
- 人格、记忆和通道身份属于同一位所有者的受治理数据。尚未确认的候选、导入草稿和其他用户的私密内容不得参与召回。
- 人格发布、永久删除、权限提升、公开推送和高风险自动部署必须由用户确认。

## 模块职责

- `packages/foundation`：版本化人格文档、草稿/发布/回滚、私有目录初始化和 DSH 会话级 RP 投影。
- `packages/memory`：记忆档案、候选审核、召回快照、工具和旧数据迁移。
- `packages/settings-ui`：仅限本机回环来源的人格、设置和审核界面。
- `packages/installer`：开发预览与安装辅助，不拥有 DSH Profile 格式。
- `cordis.patch.yml`：套件的 DSH 插件组合入口。

模块间只交换稳定、明确的数据结构。Foundation 不直接读写记忆档案；Memory 不解释或覆盖人格；设置页通过服务接口访问二者，不复制业务规则。

## 隐私与发布

- 不得把真实人格、提示词、记忆、凭据、会话、日志、迁移数据库或诊断转储复制到仓库、Issue、测试夹具或 Agent 消息中。
- 只允许发布 `personas/template` 和 `personas/example` 中的中性资产。导入的酒馆角色卡默认也是用户私有数据。
- 测试使用中性生成数据，不读取 `<PRIVATE_MISTYMOON_HOME>`、真实 DSH Home 或用户桌面文件。
- 读取私有数据时只报告结构、校验结果和路径，不回显内容。
- 暂存、提交、打包或发布前运行 `pnpm audit:publication`。

## TypeScript 与插件规范

- 使用 ESM、严格 TypeScript 和包名导入；本地相对导入保留 `.js` 后缀以匹配构建产物。
- 公共导出和非直观约束必须有简洁 JSDoc；禁止无说明的 `any` 和跨包私有类型复制。
- 配置使用 Schemastery 声明和校验。部署可变值不得硬编码；配置错误应在加载时或最早可判断的位置明确失败。
- Cordis 注册属于生命周期副作用，使用 `ctx.effect()`、`ctx.on()` 或返回 disposer 的注册接口；异步任务和子进程必须有明确的取消、关闭与所有权规则。
- Waterfall 监听器必须调用 `next()`，除非它明确且有测试地终止该流程。
- 不可信边界必须校验：JSON/JSONL、设置、模型工具参数、导入文件、进程输出和远程请求。已通过静态类型约束的同进程调用不重复做防御性校验。
- 存储格式必须带版本。破坏性变更提供显式迁移；不得静默猜测或修复无法确认的数据。
- Windows 启动器只能停止自己启动并记录句柄的进程，不按名称批量结束 NapCat、Node 或 DSH。

## 人格与记忆规则

- DSH 的安全、权限、审批、协作模式、工具治理和 Owner 当前请求始终优先且不得由 RP 覆盖。对启用 RP 的受认证 `mistymoon-rp-host-v2` 顶层 Agent，完整已发布 Persona 的 `deployment:persona` 是唯一模型可见运行时身份，精确隐藏 `harness:identity` 文案；这是身份呈现策略，不改变任何强制权限。实际 system 文本由 DSH `request/header` 持久化；模型路由沿用当前会话在 DSH Web UI 中选择的 provider/model，preset 不固定或覆盖。该 preset 不注册或暴露 `mistymoon_prepare_final_reply`，不得再叠加 `mistymoon:turn-voice` 或 `mistymoon:final-voice-refresh`。其他 preset 继续使用互斥双阶段输出画像和既有 final-reply 工具。不得按 assistant/tool step 生成新 capsule、continuation 或 anchor，不得做事后改写或二次生成。
- RP Host 可以使用只读 Web（`web_search`、`web_fetch`）以及限定在当前 Session 工作区真实路径内的 `read`、`grep`、`glob`；绝对路径、父目录跳出和符号链接不得越出该工作区。登录、表单提交、上传、购买、公开发布或其他外部副作用能力不得由该 preset 隐式获得，若未来接入必须经过代码级 capability gate 与 Owner 确认。Persona 不能授权工具、改变权限、绕过确认、安全或协作模式，也不能改写代码、命令、规则引文、数值、测试结果、诊断或技术决策。
- RP Host 的 preset/scope 边界只使用 DSH 公开 current-scope/preset/tool-restriction API 或 preset 显式注入；当前兼容实现固定 DSH rc.7，识别失败时 fail closed，不注入完整 Persona、不扩大工具面。禁止遍历 Context 原型或任意 `Symbol` 猜测宿主私有对象。
- 实际 capability gate 是 RP Host 工具权威，prompt section allowlist 不能代替它。安全、权限、审批、协作模式和外部副作用规则永远保留；只有 DSH 明确标记为可过滤的工具帮助 section 才能移除，未知 section 默认保留，不按 `tool:*` / `tools:*` 前缀猜测。工具后注册或 HMR 必须重新应用完整封闭 catalog 与执行 guard，或者要求重启 activation，不得静默扩大能力。
- Work child 始终使用中性工程 Persona、fresh one-shot Session 和固定工具白名单；不得继承 RP Persona、父 transcript、关系记忆、Recall Snapshot 或 final-reply 工具，不得再次委派。共享工作区写入默认串行，同一 RP Host 同时最多一个前台 Work activation；这些约束必须由 provider、tool restriction 和 lifecycle 状态强制，不能只依靠提示词。
- RP 展示等级与 DSH 模式正交：`off` 完全关闭，`companion` 只提供简洁身份与语气，`immersive` 提供完整人格。切换 RP 不得复制或改写 Agent 预设。
- 人格编辑先形成草稿；预览通过后才发布为活动版本。导入内容永远不能自动覆盖活动人格。
- 记忆默认采用候选审核制。明确的“请记住”可以按产品设置直接确认，自动抽取、批量导入和冲突内容不得默认批准。
- 每条正式记忆保留所有者、可见性、来源消息 ID、创建时间和修订关系。纠正以新记录替代旧记录，不改写历史。
- 模型工具不能绕过所有者范围、审核状态或来源记录直接查询底层 Provider。
- 外部记忆引擎只能实现可替换 Provider。MistyMoon 仍负责身份、治理、DSH 召回投影和审计语义。

## 测试与验证

行为变更先增加能复现问题的测试，再实现修复。至少覆盖：

- Foundation：人格解析、私有目录、草稿/发布/回滚、RP 等级和最终模型投影。
- Memory：档案生命周期、幂等来源、冲突/替代、召回可见性和迁移。
- Settings UI：本机来源限制、输入校验、草稿与审核操作。
- Bundle：构建后的 Cordis 加载冒烟和发布文件审计。

常用命令：

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:built
pnpm audit:publication
pnpm check
```

先运行与改动直接相关的测试；交付前运行 `pnpm check`。只报告实际执行过的命令，不把未运行的检查描述为通过。

## Agent 工作流

1. 阅读本文件、README、相关包和 DSH 公共接口；先检查 `git status`，保留用户已有改动。
2. 把需求落到一个明确模块接口，确认数据所有者、持久化位置、模型可见日志和失败行为。
3. 为缺陷添加回归测试；为新功能先定义公共数据结构和验收场景。
4. 使用最小范围实现，避免在设置页、工具和档案层重复同一业务规则。
5. 同步更新 README、类型文档、配置示例和必要的架构决策。
6. 运行相关测试和交付检查，记录已知限制、许可证风险与人工步骤。

协作或委派时，每个任务应限定到独立文件或模块，避免多个 Agent 同时编辑同一文件。交接信息必须包含基线 commit、修改文件、已运行命令、未解决风险和不得触碰的私有数据。研究 Agent 只写指定报告，不直接改产品代码；实现 Agent 不把未经核验的调研结论当成事实。

## Git 与发布

- 分支默认使用 `codex/` 前缀。未经用户明确授权，不提交、不推送、不创建 Release。
- npm registry 不再是面向用户的分发渠道，根包必须保持 `private: true`。Installer 与 tgz 只作为 Desktop 构建、开发预览和本机内部安装/回滚 seam，不得重新写成要求用户登录 npm 或执行 `pnpm dlx` 的安装流程。
- 计划在 P0、P1（桌面跑团模式除外）完成并通过发行验收后发布预装本套件的 DSH Desktop。封装不得修改 DSH 源码或 Profile 所有权，私有 Persona、Memory、凭据、会话和日志必须位于应用包之外的独立 DSH Home。
- Desktop 发布前必须完成许可证/第三方资产审计、可复现构建、代码签名、全新 Windows 安装、升级、回滚、卸载和用户数据保留测试；这些发布动作仍需用户明确授权。
- 不使用 `git reset --hard`、`git clean` 或覆盖用户改动的命令。
- 版本、README、锁文件、构建产物清单和发布审计必须一致。
- 外部项目只能依据其许可证和固定版本参考。AGPL 项目不得复制实现到本 MIT 套件；许可证不清晰的二进制不得随包再分发。
- 真实人格、角色卡和记忆永远不进入公开 Git 历史，即使随后删除也不例外。

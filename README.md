# MistyMoon for DeepSeek Harness

MistyMoon 是一套以角色扮演（Roleplay，简称 RP）和长期陪伴为核心的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 外置插件。项目保留 MistyMoon 的人格、关系、长期记忆与陪伴体验，同时复用 DSH 的 Agent Runtime、会话、工具、权限和 Web 插件体系，不修改 DSH 源码，也不重复实现 Agent Loop。

> 当前公开版本为 `0.0.1-rc2`，仍处于候选发布阶段。请先在本地测试环境中使用，并保留私有数据备份。

## 产品定位

MistyMoon 不是单纯的聊天 UI 或通用记忆数据库，而是 DSH 上的 RP 产品层：

- 以稳定人格、持续关系和跨会话记忆维持角色连续性。
- 允许主人在本机编辑、审核和发布自己的私有人格，不把真实人格上传到公开仓库。
- 将角色行为与通用 Agent Runtime 分离；DSH 负责推理、会话、工具和权限，MistyMoon 负责 RP 语义与陪伴体验。
- 支持未来接入 QQ/NapCat、桌面形象、手机端和主动陪伴，但这些入口共享同一人格、记忆和身份治理规则。

## 当前能力

### 私有人格与 RP

- 首次启动时，从中性模板创建一份用户私有的人格文件。
- 人格文件支持身份、关系、熟人和陌生人差异、表达规则、参考对话与回复长度预算。
- 设置页将编辑保存为不参与对话的草稿，可预览模型可见人格；只有明确点击发布后才会从下一次请求开始生效，并可回滚到旧活动版本。
- 安装或升级插件不会覆盖用户已经修改的人格。
- 真实人格只保存在用户的 DSH Home，不会进入本仓库或 npm 包。
- RP 与 DSH Agent 预设和协作模式相互独立。`minimal`、标准、Plan、权限和工具配置均保持原样；人格作为带来源的会话消息在真实用户请求前投影，不覆盖 DSH 系统提示词。长任务的后续工具步骤会重复一条精简语气提醒，降低上下文增长造成的最终回复人格漂移。
- 每个会话可使用 `/rp off`、`/rp companion` 或 `/rp immersive` 选择展示等级；默认 `companion`，Coding 场景不会把代码、命令、计划、诊断或技术决策角色化。

### 长期记忆

- 识别“请记住……”等明确请求，并写入私有的追加式 JSONL 档案。
- 按 DSH 消息 ID 去重，避免同一条消息被重复记忆。
- 召回内容以带来源的 DSH 消息写入会话，因此实际发送给模型的上下文可以从会话日志重建。
- 支持列出、纠正和遗忘记忆；旧值保留在审计历史中，但不会继续参与召回。
- 支持候选记忆的提议、查看、批准和拒绝。候选内容只有经过主人批准后才会成为正式长期记忆。
- 设置页提供候选记忆审核区域；待审核和已拒绝的候选不会进入模型上下文。

### 本机设置页

- 入口：**设置 → 插件 → MistyMoon**。
- 可编辑人格、关系规则、参考对话、回复预算和单次记忆召回上限。
- 可导入 Character Card V1/V2/V3 JSON、PNG/APNG 和 CHARX，在字段映射与人格差异预览后保存为未发布草稿。
- 角色卡的系统提示词和场景映射默认关闭；Creator Notes、问候、世界书、扩展和未知字段不会自动进入人格或模型上下文。
- 可在页面中批准或拒绝候选记忆。
- Host API 只允许本机回环来源访问，避免私有人格和记忆通过普通远程页面暴露。

### 旧版数据迁移

- 可只读预览旧 MistyMoon SQLite 数据库。
- 仅迁移状态为 `confirmed` 的长期记忆。
- 不迁移旧人格、会话、事件、候选记忆、已遗忘记录、图索引、向量索引或凭据。
- 重复执行迁移具有幂等性，不会重复导入同一条来源记录。

## 架构原则

MistyMoon 通过 DSH 原生插件扩展点实现功能：

```text
DeepSeek Harness
├─ Agent、会话、工具、权限与 Web Runtime
└─ MistyMoon RP 插件套件
   ├─ foundation     私有人格生命周期与会话级 RP 投影
   ├─ memory         长期记忆、候选审核与召回
   ├─ settings-ui    本机设置和候选记忆审核页面
   └─ installer      开发预览安装器
```

记忆插件只维护一个进程级档案实例。Agent 工具、召回流程与设置页共同使用该实例，避免多个进程内视图同时写入同一份 JSONL 文件。DSH 会话保存原始对话和模型可见投影，MistyMoon 记忆档案只保存经过选择的跨会话事实。

详细模块职责、外部记忆 Provider 和安全边界见 [架构说明](docs/architecture.md)；开发与 Agent 协作遵循 [AGENTS.md](AGENTS.md)。

## 本套件包含的插件

下表中的组件随 `@mistymoon/dsh` 一起维护和发布，属于 MistyMoon 插件套件：

| 组件 | DSH 加载名或入口 | 职责 |
| --- | --- | --- |
| Foundation | `@mistymoon/dsh/foundation` | 私有人格生命周期、RP 等级、会话级人格投影、Character Card 解析和字段映射 |
| Memory | `@mistymoon/dsh/memory` | 长期记忆档案、候选审核、召回快照和记忆工具 |
| Settings UI Host | `@mistymoon/dsh` | 本机回环 RPC、人设草稿/发布/回滚、角色卡导入和记忆审核 |
| Settings UI Client | `@mistymoon/dsh/client` | DSH Web 中的 MistyMoon 设置页面 |
| Bundle Patch | `cordis.patch.yml` | 将以上运行时插件组合进 DSH Profile |
| Preview Installer | `@mistymoon/dsh-installer` | 源码开发预览和本机安装辅助，不是常驻运行时插件 |

以下项目不属于本套件，也不会因为安装 MistyMoon 而自动随包提供：`dsh-noema`、`dsh-anchored-standard`、DeepSeek Harness Desktop、Mnemon、Mem0、NapCat、OwO-Desktop、Live2D Runtime 与任何角色模型或素材。它们只是已评估的外部项目、未来可选 Provider/Adapter 或用户独立安装的依赖，各自保留自己的许可证、配置和发布责任。

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- DeepSeek Harness `0.1.0-rc.6`

## 安装到 DSH

当前候选版本建议从源码构建并通过 DSH 官方插件命令安装：

```powershell
cd D:\ai\MistyMoon-DSH
pnpm install
pnpm build

cd D:\ai\deepseek-harness
pnpm dsh plugin --profile web add D:\ai\MistyMoon-DSH
pnpm dsh --profile web
```

DSH 负责生成和维护 Web Profile。MistyMoon 不会手工修改 DSH 仓库或 Profile 的 `package.json`。

MistyMoon 不要求专用 Agent 预设。可在任意 DSH 预设和协作模式中用 `/rp` 查看当前 RP 等级；需要纯 DSH Coding 体验时使用 `/rp off`，需要轻量陪伴语气时使用默认的 `/rp companion`，完整 RP 使用 `/rp immersive`。

若端口 `3080` 已被其他 DSH 进程占用，可以停止旧进程，或为新实例指定其他端口：

```powershell
pnpm dsh --profile web --port 3081
```

## 开发预览

Windows 默认将预览数据保存在 `%LOCALAPPDATA%\MistyMoon\dsh`。可以通过 `MISTYMOON_DSH_HOME` 指定其他私有目录。

```powershell
pnpm preview:install
pnpm preview:smoke
pnpm preview:start
```

指定 Web 端口：

```powershell
pnpm preview:start -- --port 3081
```

## 迁移旧记忆

先只读预览，不修改源数据库和目标档案：

```powershell
pnpm preview:migrate-memory -- D:\path\to\legacy.db
```

确认统计结果和警告后，再显式导入：

```powershell
pnpm preview:migrate-memory -- D:\path\to\legacy.db --apply
```

## 私有数据与开源边界

仓库只发布插件代码、中性人格模板和示例人格。以下内容被发布审计和 `.gitignore` 排除：

- 用户真实人格与提示词
- 长期记忆、候选记忆和迁移数据
- DSH 会话、日志和运行状态
- `.env`、API Key、Token 与其他凭据
- SQLite、JSONL 和用户导出文件

默认私有文件位于 DSH Home 下的 `mistymoon` 目录中：

```text
mistymoon/
├─ persona/
│  ├─ persona.json
│  ├─ draft.json（仅在存在未发布草稿时）
│  └─ versions/（活动人格的回滚历史）
├─ memory/memories.jsonl
└─ settings/settings.json
```

发布前必须运行：

```powershell
pnpm audit:publication
```

## 开发与验证

```powershell
pnpm install
pnpm check
```

`pnpm check` 会依次执行严格类型检查、单元测试、构建、已构建 Cordis 插件冒烟测试和发布隐私审计。

## 待更新内容

下面是当前计划，优先级可能根据实际 RP 体验和测试结果调整。未勾选项目不代表已经可用。

### P0：RP 连续性、记忆可靠性与治理

- [x] 版本化私有人格、关系规则、参考对话与回复预算
- [x] 明确记忆的追加式保存、纠正、遗忘和审计历史
- [x] 候选记忆的提议、批准、拒绝和设置页审核
- [x] RP 展示等级与 DSH 预设/协作模式正交，兼容 `minimal` 且不覆盖 Coding、工具、权限和安全规则
- [x] 长任务每个后续模型步骤注入可审计的精简语气提醒，避免完整人格在长上下文中被稀释
- [x] 人格草稿、精确预览、显式发布、并发覆盖保护和版本回滚
- [x] Character Card V1/V2/V3 JSON 的不可信输入解析、未知字段保留和私有草稿模型
- [x] Character Card 草稿预览、字段映射 UI，以及带大小/路径/压缩比限制的 PNG/APNG、CHARX 容器解析；详见 [导入设计](docs/persona-import.md)
- [ ] 自动候选提取 Provider：对回复后的稳定事实生成候选，但不自动批准
- [ ] 冲突检测与替代链：发现矛盾时要求主人选择，接受新值后以墓碑和 `supersedes` 保留旧值
- [ ] 记忆整合、衰减、归档与恢复
- [ ] 专用记忆管理页：搜索、筛选、批量审核和来源查看
- [ ] 为记忆日志增加版本化迁移、文件锁、原子写入和损坏恢复工具
- [ ] BM25、PageIndex 与图关系融合召回，以及可解释的召回结果
- [ ] 候选记忆的编辑、合并和不含敏感载荷的操作审计

### P1：陪伴与通信

- [ ] NapCat/QQ Channel Adapter
- [ ] MistyMoon 启动时启动 NapCat，并提供健康检查、重连和受控关闭
- [ ] 主人、熟人和陌生人的通道身份映射与 RP 隐私策略
- [ ] 主动陪伴调度、免打扰时段和频率限制
- [ ] Presence 状态：情绪、动作和桌宠展示意图
- [ ] 不同入口共享角色连续性，同时避免把一个用户的私密记忆泄露给另一个用户

### P2：桌面端与移动端

- [ ] Windows Launcher 与类似游戏的单安装器体验
- [ ] 配置代际、启动健康检查和上一个可用版本回滚
- [ ] Windows 代码签名、更新包哈希和离线签名验证
- [ ] 手机端页面与安全的远程 RP 会话入口
- [ ] 基于系统 SSH 端口转发或窄权限 SSH Gateway 的手机直连方案
- [ ] Noema 只读 shadow mode 与可选记忆 Provider；通过身份、来源、生命周期和 Windows 一致性门槛后再开放替换
- [ ] Mnemon 和 Mem0 可选记忆 Provider
- [ ] LivingMemory 逻辑数据导入器，不复制其 AGPL 实现

### P3：表现层与受控演化

- [ ] 可选 Live2D/桌宠适配器，将 RP 状态映射为表情和动作，并与 Agent Runtime 解耦
- [ ] 模型、动作、字体、声音等第三方素材的独立许可证审查
- [ ] 隔离工作区中的自我修改、测试和风险分级
- [ ] 仅对低风险插件变更自动部署，并提供健康检查与自动回滚
- [ ] 人格发布、永久删除记忆、权限提升和公开推送始终要求人工确认

## Windows 打包说明

计划采用单个安装程序提供类似游戏客户端的安装体验。安装完成后的 Electron、Node 和 DSH Runtime 通常仍是目录结构，不承诺把全部运行时压缩成一个长期自解压的 PE 文件。这样更利于增量更新、签名校验、故障诊断和安全回滚。

## 许可证

本仓库使用 [MIT License](LICENSE)。DeepSeek Harness、Electron、NapCat、Mem0、Mnemon、Live2D 组件、模型、字体、声音及其他第三方依赖仍保留各自许可证和 NOTICE 要求。

OwO-Desktop、Live2D Cubism 模型或朋友项目中的素材不会因为本仓库使用 MIT 就自动获得再分发许可；接入前必须分别确认代码与素材授权。

# 外部人格与酒馆角色卡导入设计

MistyMoon 将支持导入 Tavern/SillyTavern 生态的 Character Card V1、V2、V3。导入是“解析为私有草稿并由用户确认映射”，不是直接执行角色卡中的提示词，也不会自动覆盖活动人格。

规范基线：

- Character Card V1/V2：[`malfoyslastname/character-card-spec-v2@8083fb3`](https://github.com/malfoyslastname/character-card-spec-v2/blob/8083fb388615ccbce768e97cbbd49d2b3214632c/spec_v2.md)
- Character Card V3：[`kwaroran/character-card-spec-v3@f3a86af`](https://github.com/kwaroran/character-card-spec-v3/blob/f3a86af019fbd99f788f7a1155f399655b34ab35/SPEC_V3.md)

V3 目前仍被其仓库描述为提案，因此解析器按向前兼容方式保留未知字段，并在 `spec_version` 高于已支持版本时给出警告。

## 已实现的格式支持

1. V1/V2/V3 JSON：解析、字段映射和预览，不直接写入活动人格。
2. PNG/APNG：读取 `chara` 和 `ccv3` 文本块；两者同时存在时优先 V3，并校验 PNG 块边界和 CRC。
3. CHARX：只读取压缩包根目录 `card.json`，拒绝路径穿越、重复路径、非 ASCII 路径、加密条目、异常展开大小和压缩比；资产不会解压或执行。
4. 后续可选导出：仅导出用户明确选择的字段和有再分发权的资产。

## 中间数据

解析器输出版本化 `PersonaImportDraft`，预览响应带来源格式、源文件哈希、解析警告和未映射字段。原始文件只通过本机回环 Host API 解析，不落入 Git 工作区；用户确认映射后只生成未发布的 MistyMoon 人格草稿。

| 角色卡字段 | MistyMoon 目标 | 导入规则 |
| --- | --- | --- |
| `name` / `nickname` | 显示名和角色称呼 | V3 有 nickname 时用于角色宏预览，不替代稳定 ID |
| `description` | 身份描述草稿 | 展示差异后由用户确认 |
| `personality` | 性格与行为草稿 | 不直接执行；进入可编辑草稿 |
| `scenario` | 场景/关系候选 | 不能自动推断“主人”关系 |
| `system_prompt` | 高权限指令候选 | 隔离显示，默认不启用，不能替换 DSH 安全和权限提示 |
| `post_history_instructions` | 回复规则候选 | 作为低优先级 RP 风格草稿审阅 |
| `mes_example` | 参考对话 | 解析为示例，不视作真实会话或记忆 |
| `first_mes` / greetings | 开场白草稿 | 不并入稳定人格或长期记忆 |
| `creator_notes` | 元数据 | 永不送入模型；V2 规范明确它不是提示词 |
| `character_book` | 世界书导入候选 | 与人格分离，后续经独立审核和预算策略接入 |
| `extensions` / 未知字段 | 不透明保留区 | 不执行、不联网、不丢弃，供重导出或适配器使用 |
| assets | 私有资产清单 | 默认不加载远程 URI；脚本、模型和可执行内容不运行 |

`{{char}}`、`{{user}}` 等宏只在受控渲染器中替换。扩展字段、正则脚本、Lua/JavaScript、远程 URL 和嵌入式模型均视为不可信数据，不能借导入获得工具、文件、网络或进程权限。

## 安全限制

- 导入 API 限制总文件大小、JSON 深度、字符串长度、字段数量和资产数量。
- PNG 解码只读取规定文本块，不接受借图片元数据触发的外部引用。
- CHARX 拒绝绝对路径、`..`、重复规范化路径、加密压缩包、超限展开大小和异常压缩比，防止路径穿越与 zip bomb。
- 远程资产 URI 只显示域名和风险，不自动下载；私有网络地址同样不例外。
- 所有导入结果先写新草稿，展示字段级差异、警告和丢失信息。发布动作需要用户确认并产生新人格版本。
- 导入失败不留下半写文件；草稿和活动人格使用临时文件、同步落盘和原子替换。

## 许可证与隐私

角色卡格式规范公开不代表每张角色卡、头像、Live2D、声音、世界书或提示词都允许再分发。MistyMoon 只提供格式解析能力；用户负责确认导入内容的授权。导入文件、草稿和衍生人格默认保存在 DSH Home，不进入本 MIT 仓库、npm 包、遥测或公开诊断。

## 验收条件

- V1/V2/V3 JSON 解析有中性固定夹具和错误夹具。
- 未知扩展可无损保留，`creator_notes` 从不出现在模型请求中。
- 任何 `system_prompt` 都只能进入待审核草稿，无法覆盖 DSH 权限与安全段。
- PNG/CHARX 的路径、大小、压缩比和远程资产策略有拒绝测试。
- 发布、回滚和重复导入保持版本历史，且不把导入内容写入 Git 工作区。

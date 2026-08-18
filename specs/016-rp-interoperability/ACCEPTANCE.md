# 016 验收标准：RP 互操作、Prompt Itemization 与派生摘要

## 1. Fixture 与隐私

- [x] V2/V3/CHARX、Worldbook、群聊、summary 和 scope fixtures 全为中性生成数据。
- [x] parser conformance 保留未知 extension 且默认不映射 system prompt；Character、Owner Persona 与 Relationship 使用独立 fixture 文档。
- [x] publication audit 不发现真实卡、记忆、会话、素材、凭据或本机路径。

## 2. Projection 与 Itemization

- 每个 item 有 source/revision/position/budget/reason/hash；总预算确定且稳定。
- Worldbook 相同输入得到稳定顺序；超预算按显式 priority/order 截断，不在控制文本中间切断。
- 实际 system 文本或模型可见消息可从 DSH `request/header` / Session events 重建。

## 3. Speaker

- manual、mention、ordered、weighted 均返回可审计 receipt；固定 seed 的 weighted 选择可复现。
- 一个 request 最多一个 active speaker；不可见角色的私有设定零泄漏。
- 多角色 prompt 不能覆盖 DSH safety、权限、工具或 Owner 当前请求。

## 4. Summary 与 Citation

- summary 编辑、暂停和 rollback 创建 revision，不改写来源历史。
- 任一 source 被 supersede/forget 后，依赖 summary 不再召回；重建后引用当前 source revisions。
- vector/graph 只返回 ID/score/reason，正文从权威档案回查。

## 5. `dsh-tavern` rc.7 smoke

- [x] 固定 commit 的预构建 Host 在全新系统临时 DSH Home 完成 rc.7 import/load/dispose；不读取或修改真实 DSH Home。
- [x] 跨 Owner session remote 因只接受任意 `sessionId` 且无调用者绑定，被 conformance gate 判定为不合格；因此不继续把 fork Remote 当作可接受能力。
- [x] smoke 记录源码构建工具链不完整、TypeScript 5.5→6 decorator 差异和 rc.6→rc.7 的实际加载阶段，不把 peer range 当作通过。
- [x] 第三方源码和构建产物不进入 MistyMoon 发布包。

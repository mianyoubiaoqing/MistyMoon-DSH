# 013：角色场景与跑团体验模式

状态：设计草案，待用户 Review。本文件把类酒馆 RP 和桌面跑团纳入路线，不授权实现、导入真实角色卡或推进真实战役状态。

## 设计依据

知识库把“核心体验”定义为玩家最核心的感受，把“核心玩法”定义为玩家本质上持续做的事情，并要求核心循环让玩法和体验持续产生；核心系统负责维持该循环（`game-design.pdf` 第 40–42 页）。知识库将 TRPG 描述为由主持人掌控规则、NPC 扮演与剧情讲述的桌面角色扮演活动（第 56 页）。

对象映射：MistyMoon 的 RP Host Agent 在 Character Scene 中扮演选定角色，在 Tabletop Campaign 中承担主持与叙述；玩家持续声明言行并接收有状态后果。任何工作分析可以委派，但面向玩家的角色表达和 Canon State 提交只能由 RP Host Agent 完成。

## 三条正交轴

| 轴 | 值 | 决定什么 | 不决定什么 |
| --- | --- | --- | --- |
| RP Presentation Level | `off` / `companion` / `immersive` | Persona/Scene Role 展示强度 | 工具、权限、模型路由 |
| Experience Mode | `companion-chat` / `character-scene` / `tabletop-campaign` | 叙事规则、状态和记忆范围 | DSH Plan/协作能力 |
| DSH Collaboration Mode | DSH 已公开模式 | 计划、工具与协作行为 | 人格、场景或战役正史 |

切换 Presentation Level 不复制或改写 Agent 预设。`off` 时保留所选 Experience Mode 和已有 Canon State，但停止角色化表达并禁止自动推进虚构状态；恢复 RP 后继续原 scope。

## Experience Mode A：Companion Chat

当前长期陪伴模式。RP Host Agent 使用已发布 Persona 与 Companion Reality 范围的 Confirmed Memory；没有 Scene Role、Campaign Branch 或游戏裁定。它仍是默认模式。

## Experience Mode B：Character Scene

### 核心体验

知识库术语：`角色扮演`。

对象映射：玩家与一个明确发布的 Scene Role 在有边界的虚构场景中连续互动，角色保持身份、关系、地点和已发生事件的一致性。

### 核心玩法

玩家本质上持续做的事情是声明台词、动作或场景意图；RP Host Agent 以 Scene Role 回应，并在有状态后果时提交该 Story/branch 的 Canon State。

### 最小产品范围

- 一个 Character Scene 选择一个已发布 Scene Role、一个场景设定和一个 fiction scope。
- Character Card 导入永远先成为私有草稿；`system_prompt`、`post_history_instructions`、世界书、示例对话和未知扩展不能因进入该模式而自动获得系统优先级。
- Scene Role 与长期陪伴 Persona 分开发布和选择；进入场景不能覆盖活动 Persona。
- 场景可暂停、继续和显式分支。分支只继承分叉点前的 Canon State。
- 多角色群像、自动世界书触发、创作者脚本和远程素材下载不属于第一阶段。

后续群聊由显式 `SpeakerPolicy` 选择 active speaker，支持 manual、mention、ordered 与 weighted policy，并记录 speaker receipt。一个 provider request 最多一个 active speaker/persona；未选角色只以经过 visibility 与预算过滤的场景上下文出现，不能让多个角色 prompt 自行竞争 system authority。

### 状态与记忆

Character Scene 的 Canon State 保存当前地点、在场角色、对象状态、公开约定和分支；它是确定状态，不依赖语义召回。已发生的 scene episode 可以进入同一 fiction scope 的记忆索引，但不能进入 Companion Reality。

## Experience Mode C：Tabletop Campaign

### 核心体验

知识库术语：`角色扮演`，可叠加规则挑战、资源管理或谜题破解，但附加体验不得破坏角色扮演与后果连续性。

对象映射：玩家以角色身份在持续世界中作决定，主持人依据可见条件、规则和可审计随机结果给出后果；战役世界在多次会话后保持一致。

### 核心玩法

玩家本质上持续做的事情是观察场景、声明行动和作出角色决策。RP Host Agent 负责呈现信息、判断是否需要裁定、叙述结果并提交 Canon State。

### 核心循环

~~~mermaid
flowchart LR
  A["信息：呈现场景与可见条件"] --> B["行为：玩家声明行动"]
  B --> C{"分支：是否需要裁定"}
  C -- "是" --> D["循环/流程：规则与骰子裁定"]
  C -- "否" --> E["信息：叙述确定性结果"]
  D --> F["信息：叙述裁定结果与代价"]
  E --> G["信息：提交状态与事件"]
  F --> G
  G --> H["循环/流程：进入下一行动"]
  H --> A

  classDef action fill:#EEF3FB,stroke:#111,stroke-width:2px,color:#111;
  classDef info fill:#FFF5D6,stroke:#111,stroke-width:2px,color:#111;
  classDef branch fill:#FBE0E0,stroke:#111,stroke-width:2px,color:#111;
  classDef loop fill:#E9E0FA,stroke:#111,stroke-width:2px,color:#111;
  class B action;
  class A,E,F,G info;
  class C branch;
  class D,H loop;
~~~

### 游戏系统

~~~mermaid
flowchart LR
  G["游戏系统"] --> C["核心系统"]
  G --> P["周边系统"]
  C --> C1["场景呈现系统"]
  C --> C2["规则裁定系统"]
  C --> C3["战役正史系统"]
  P --> P1["角色与资源管理系统"]
  P --> P2["分支与回顾系统"]
  P --> P3["虚构记忆检索系统"]

  classDef root fill:#000,stroke:#000,stroke-width:2px,color:#fff;
  classDef category fill:#626A73,stroke:#111,stroke-width:2px,color:#fff;
  classDef system fill:#F5F7FA,stroke:#111,stroke-width:2px,color:#111;
  class G root;
  class C,P category;
  class C1,C2,C3,P1,P2,P3 system;
~~~

### 主持、规则和随机性

- RP Host Agent 是唯一面向玩家的主持者，也是唯一 Canon Commit Consumer。
- Rules Work Agent 可以查规则、计算修正值或提出状态变更，但只能返回 Work Report；不能直接宣布结果或改写 Canon State。
- 骰子和随机表必须由可审计工具产生并写入 DSH 会话；模型不得伪造随机结果。
- 规则不明确时，RP Host Agent应区分规则原文、临时裁定与 Owner 选择。临时裁定只有提交后才成为该战役约定。
- 不同规则集通过 Adapter 接入；规则书文本、授权素材和第三方数据不随 MIT 包自动再分发。

### Canon State

每个 Campaign Branch 的 Canon State 至少区分：角色表、资源/库存、地点与对象、任务/线索、持续效果、战役约定和已提交事件。状态变化采用提议 → 校验 → 单次 commit；回复生成失败、工具取消或规则分析失败不能留下半提交状态。

战役 episode 用于回顾和召回过去事件；角色当前生命值、库存和任务阶段等仍从 Canon State 读取，不能依赖记忆 top-k 猜测。

## RP Host Agent 与 Work Agent 的职责

| 行为 | RP Host Agent | Work Agent |
| --- | --- | --- |
| 面向 Owner/玩家扮演 | 唯一负责 | 禁止 |
| 场景与结果叙述 | 负责 | 可提供事实/规则建议 |
| 编码、检索、长规则分析 | 只委派 | 负责 |
| 骰子/外部工具 | 发起或委派并引用结果 | 在权限内执行 |
| Canon State commit | 唯一负责 | 只能提议 |
| 最终回复人格化 | 负责 | 禁止 |

Work Report 中的代码、命令、规则引文、数值和验证结果必须按原样保留；RP Host Agent 可以在其外层使用角色语气，但不能改写技术或裁定事实。

## 切换与生命周期

- 新会话默认 `companion-chat`；进入其他模式需要显式选择 Story/Campaign scope。
- 切换 mode 前先持久化当前 scope；不能把上一模式的 active recall 继续带入下一请求。
- 从 Character Scene/Campaign 返回 Companion Chat 时，只加载 Companion Reality；可用一句中性事实说明已离开虚构 scope。
- 删除 Story/Campaign、发布 Scene Role、合并 Campaign Branch 和永久删除记录均需用户确认。

## 安全与隐私

- DSH 系统提示词、权限、安全和工具规则始终优先；角色卡和规则素材都是不可信数据。
- 私有 Scene Role、世界设定、角色表、战役日志和掷骰记录不进入仓库、fixture 或诊断转储。
- 共享频道需要参与者与披露范围模型；在身份映射完成前，Character Scene 与 Campaign 只支持 Owner 私有会话。
- Work Agent 不接收整段亲密 RP 历史；委派 envelope 只含完成任务所需的最小上下文。

## 路线顺序

1. 先完成 RP Host/Work Agent delegation 原型与隔离测试。
2. 增加 Experience Mode 会话状态，但只开放 `companion-chat` 与空的 scope 切换测试。
3. 实现单 Scene Role 的 Character Scene、分支和 fiction memory 隔离。
4. 实现无特定规则集的 Tabletop Campaign Canon State 与确定性行动。
5. 增加可审计 dice tool 和一个宽松许可规则 Adapter 的原型。
6. 最后评估多角色、世界书触发和共享频道。

## 尚待用户决定

1. Character Scene 第一版是否坚持单 Scene Role；本规范推荐是。
2. Tabletop Campaign 第一版采用系统无关核心，还是内置一个宽松许可 SRD Adapter；本规范推荐系统无关核心 + 独立示例 Adapter。
3. Companion Persona 是否可以作为战役主持人的表现外壳；本规范推荐允许，但 Canon State 与 Persona 必须分离。
4. 是否允许用户显式把虚构共同创作标记为 Companion Reality 的共同经历；本规范默认不允许自动转换。

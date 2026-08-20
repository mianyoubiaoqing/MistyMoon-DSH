# RP Host 使用 Persona 身份与封闭能力边界

RP Host 以已发布 Persona 作为唯一模型可见运行时身份，沿用 DSH Web UI 为会话选择的模型，并只开放只读 Web、当前会话工作区内的 `read` / `grep` / `glob`、Owner 询问和固定 Work 委派。真实工具能力由 capability gate 强制；DSH 的安全、权限、审批、协作模式和外部副作用规则始终保留，只有 DSH 明确标记为可过滤的工具帮助 section 才可移除，未知 section 默认保留。

RP Host 的 preset/scope 判断只依赖 DSH 公开 API 或显式注入。当前固定 DSH rc.7；兼容代码识别失败时不投影完整 Persona并拒绝扩大工具面，不扫描 Cordis Context 的任意 Symbol，也不依赖宿主私有对象结构。工具注册或 HMR 后每次组装都重新应用封闭 catalog 和执行 guard，不能静默扩大能力。

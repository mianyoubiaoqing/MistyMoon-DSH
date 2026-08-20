# Desktop 捆绑分发取代 npm 用户安装

MistyMoon 不再把 npm registry、`pnpm dlx` 或全局 npm 登录作为最终用户的安装与更新入口。完成 P0 和 P1（桌面跑团模式除外）并通过发行验收后，项目将发布一个预装 MistyMoon 插件套件的 DSH Desktop；普通用户只安装、启动和更新这一签名应用，不再单独 provision 插件包或 Agent preset。

仓库根包设为 `private`，防止误发布到 npm。现有 installer、tgz 打包、版本化 artifact 指纹、preset provision、事务补偿、状态检查和回滚代码继续保留，但其角色改为 Desktop 构建/封装流水线与本机内部安装 seam，不再构成公开用户分发承诺。开发预览仍可从源码调用这些能力。

Desktop 封装不得改变模块所有权：DSH 继续拥有 Runtime、Profile、会话、工具、权限和模型路由；MistyMoon 只通过公开扩展点装载。真实 Persona、Memory、凭据、会话和日志继续存放在应用包之外的独立用户 DSH Home，更新应用不得覆盖或打包这些私有数据。

首个 Desktop 发行版必须在全新 Windows 环境完成许可证与第三方资产审计、可复现构建、代码签名、安装/升级/回滚、用户数据保留、卸载边界和故障恢复测试。未经单独授权，本决策不允许修改 DSH 源码、再分发许可证不明的二进制或素材、发布构建、创建 Release、签名或迁移真实用户数据。

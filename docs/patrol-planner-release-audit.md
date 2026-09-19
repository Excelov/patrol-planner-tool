# v0.4.0-beta.1 发布前盘点

## 已具备

- 本地 Python 服务和桌面启动脚本
- 应用内 DXF 解析并生成管线、设施 GeoJSON，坐标预览/校准和核查报告
- 手工点位、任务点、载具选择和高德分段算路
- 多方案保存、累计覆盖、GPX/KML/CSV/GeoJSON 导出
- PyInstaller 单文件便携版及 Inno Setup 6.7.3 安装器实体，已完成静默安装/启动/卸载验收
- 已验证单文件 EXE 可启动并在无外部 Python 进程时直接解析真实 DXF（4848 条管线、2429 个任务点）
- 不含 Key 和生产数据的发布压缩包，已生成 SHA256 校验值和发布清单
- GitHub Actions 已固定 Inno Setup 版本，并对公开源码包执行独立回归测试
- 已生成包含 `main`/`develop` 分支的干净 Git 仓库和合成示例 GIS 数据

## 仍缺少

1. 设施块名映射仍需使用客户真实图纸完成业务抽样验收。
2. 真正的道路吸附、道路侧别和合法折返仍需真实高德道路结果验证（当前提供诊断和人工复核）。
3. 多用户账户、权限、订阅和云端数据隔离属于后续 SaaS 版本。
4. 正式 GitHub remote 尚未配置，当前只生成本地干净仓库。

## 发布阻塞

当前主工作区仍未配置 GitHub remote。干净仓库已在 `release/patrol-planner-github-repo-v8` 生成并提交；待提供目标仓库 HTTPS 或 SSH 地址后即可添加 remote 并推送。

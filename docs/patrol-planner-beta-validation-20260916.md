# 巡线工坊 beta 验收记录（2026-09-17）

## 已验证

- 应用内 DXF 导入：冻结版 EXE 启动后可调用 `/api/import/dxf`，历史 DXF 能返回管线和设施对象。
- 手动点位：顺序锁定、任意点后插入、超过 16 个途经点自动分段。
- 人工路线：按地图点位顺序生成道路方案，支持任意点后插入、局部重算和连续分段。
- 路线诊断：控制点贴合率、覆盖率、绕行提示、掉头和桥梁连接提示。
- 路线评分：覆盖率优先，叠加任务点、顺序、合法转向和绕行惩罚。
- 几何回归测试：15 项人工路线、坐标、覆盖与转向诊断测试，全部通过。
- 服务端测试：7 项导入、分段、错误隔离与路线诊断测试，全部通过。
- 便携版：PyInstaller 单文件 EXE，已实际启动验证。
- 冻结版 DXF 端到端：真实 DXF 经 `/api/import/dxf` 上传后返回 4848 条管线、2429 个设施任务点，并保留坐标预判信息。
- 高德地理编码插件未加载时，道路匹配检查会回退到本地几何邻近检查，不再因插件缺失中断。

## 当前发布物

- `release/patrol-planner-v0.4.0-beta.1-portable.zip`
- `release/SHA256SUMS-v0.4.0-beta.1.txt`

## 已知发布前置条件

- 安装器脚本：`release/installer/patrol-planner.iss`
- 构建脚本：`release/installer/build-installer.ps1`
- GitHub Actions 构建：`.github/workflows/patrol-planner-windows.yml`（Windows runner 自动生成安装器）
- 本机构建机已安装 Inno Setup 6.7.3，并生成 `release/patrol-planner-0.4.0-beta.1-setup.exe`，SHA256 已写入发布清单。
- 安装器实测：静默安装返回 0，安装目录中的 EXE 可启动并返回配置令牌，静默卸载返回 0；测试临时目录已清理。
- 道路侧别和合法掉头目前是道路几何候选与诊断提示，最终合法性仍需高德道路结果和人工确认。
- 自动草稿、双侧候选和全局优化暂不进入当前发布版，后续单独开发和验收。

## 验收命令

```powershell
node --test frontend/patrol-planner/test_geometry.mjs
Push-Location frontend/patrol-planner
python -m unittest -v test_server.py
Pop-Location
```




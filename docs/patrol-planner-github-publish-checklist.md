# 巡线工坊 GitHub 发布清单

## 仓库边界

建议从当前工作区提取独立仓库，只保留：

- `frontend/patrol-planner/`
- `scripts/evaluate_pipeline_drafts.mjs`
- `scripts/verify_portable.ps1`
- `scripts/verify_release.ps1`
- `release/installer/`
- `.github/workflows/patrol-planner-windows.yml`
- 脱敏示例 GeoJSON、README、CHANGELOG 和版本清单

不复制真实 DXF/GIS、运行日志、模型、企业映射表、高德 Key、许可证私钥及其他项目目录。

## 分支和标签

```text
main       可交付稳定版本
develop    集成验证
feature/*  独立功能
```

首个公开标签：`v0.4.0-beta.1`。安装器生成后再建立 `v0.4.0-beta.2`。

## 发布前检查

```powershell
node --test frontend/patrol-planner/test_geometry.mjs
Push-Location frontend/patrol-planner
python -m unittest -v test_server.py
Pop-Location
.\scripts\verify_portable.ps1
.\scripts\verify_release.ps1
.\scripts\verify_beta.ps1
```

GitHub Release 只上传脱敏示例和便携包；客户专属数据与许可证通过私有交付渠道提供。

当前已生成脱敏源码包：`release/patrol-planner-v0.4.0-beta.1-source.zip`。发布前核对 `release/SHA256SUMS-v0.4.0-beta.1.txt`，源码包 SHA256 以 `release/SHA256SUMS-v0.4.0-beta.1.txt` 清单为准。正式安装器由 GitHub Actions Windows runner 执行 Inno Setup 构建。

统一构建与验收状态见 `release/RELEASE-MANIFEST-v0.4.0-beta.1.json`。




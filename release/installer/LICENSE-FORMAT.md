# 巡线规划小工具许可证格式 v1

许可证由签发端使用私钥签名，客户端只内置公钥并验证签名，不保存签发私钥。

```json
{
  "licenseId": "客户-设备-序号",
  "customer": "客户名称",
  "expiresAt": "2027-12-31T23:59:59+08:00",
  "deviceHash": "设备指纹",
  "features": ["dxf-import", "facility-mapping", "route-planning", "gpx-export"],
  "version": "0.x"
}
```

开发版可使用本地测试许可证；正式版在启动时验证设备、有效期、功能和版本范围。许可证不包含 DXF、GIS 或高德 Key。

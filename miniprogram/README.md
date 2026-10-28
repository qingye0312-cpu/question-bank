# 微信小程序

源码在 [`miniprogram/miniprogram/`](miniprogram/)，页面负责搜索、详情、录题、登录申请和设置；业务服务在 `services/`。

`core/`、`generated/` 和 `theme.json` 中涉及桌面共享逻辑的文件由 `scripts/sync-client-assets.mjs` 生成，源头是 `desktop/shared/`。索引数据由 `tools/mobile-index/build.mjs` 从 `tools/mobile-index/sources/` 生成到 `miniprogram/miniprogram/data/`。

## 检查

```sh
node scripts/sync-client-assets.mjs --check
node scripts/build-miniprogram-vendor.mjs --check
node tools/mobile-index/build.mjs --bundle --check
pnpm check:miniprogram
pnpm test:miniprogram
```

小程序只使用云端公开目录、快照、手机号登录/申请和上传接口；题库正式历史与维护者回退由桌面管理入口和云端服务负责。

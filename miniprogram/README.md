# 微信小程序

源码在 [`miniprogram/miniprogram/`](miniprogram/)，页面负责搜索、详情、录题、登录申请和设置；业务服务在 `services/`。

`core/`、`generated/` 和 `theme.json` 中涉及桌面共享逻辑的文件由 `scripts/sync-client-assets.mjs` 生成，源头是 `desktop/shared/`。小程序不内置题目，正式题库由云端目录和快照下载到 `wx.env.USER_DATA_PATH`，本地缓存优先显示，前台进入时静默按 revision 与摘要检查并替换。

## 检查

```sh
node scripts/sync-client-assets.mjs --check
node scripts/build-miniprogram-vendor.mjs --check
node tools/mobile-index/build.mjs --cloud-only --check
pnpm check:miniprogram
pnpm test:miniprogram
```

小程序只使用云端公开目录、快照、手机号登录/申请和上传接口；首次打开需要联网下载题库，之后离线使用已保存的云端快照。题库正式历史与维护者回退由桌面管理入口和云端服务负责。

# 桌面前端

React/Vite 前端入口是 `main.tsx`。

| 区域 | 入口 |
| --- | --- |
| 主布局、题库切换、弹窗 | `main.tsx` |
| 云端登录和维护 | `cloud-client.ts`、`cloud/` |
| 录题和待上传 | `intake-panel.tsx`、`intake/`、`intake-hub.tsx` |
| 搜索和结果展示 | `search-presentation.ts`、`use-question-results.ts`、`detail-results.tsx`、`speed-results.tsx` |
| OCR | `ocr-client.ts`、`ocr-panel.tsx`、`ocr/` |
| 导出 | `question-export.tsx`、`question-export.css` |
| 设置与视觉系统 | `styles.css`、`settings/` |
| 生成文件 | `generated/`，由 `scripts/sync-client-assets.mjs` 生成 |

所有全屏弹窗的尺寸变量集中在 `styles.css` 的 `--dialog-*` 定义；页面级 CSS 只处理内容和响应式排列。

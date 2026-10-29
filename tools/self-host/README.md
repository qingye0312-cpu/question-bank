# 自托管服务运行手册

服务源码位于 [`cloud/qbank-auth/`](../../cloud/qbank-auth/)，部署包由 `pnpm build:self-host` 生成。生产数据只在服务器 `QBANK_STORAGE_ROOT`，部署采用带版本目录的原子切换。

## 本地验证

```sh
pnpm build:self-host
pnpm test:self-host
```

## 部署边界

- 先备份服务器数据目录，再上传当前版本包。
- 解压到新目录，运行健康检查和只读目录/快照检查。
- 通过原子链接切换当前版本；失败时保留旧版本和数据，不覆盖运行中的目录。
- 部署完成分别记录服务包、HTTP 健康、清单、代码哈希和客户端行为，不能用其中一项代替其他证据。

生产环境变量放在服务器受限文件中，至少包含 `QBANK_STORAGE_ROOT`、监听地址/端口和会话密钥。不要把 `.env`、私钥、证书或真实数据库复制到仓库。

## 更新源

桌面更新源提供 `latest.json`、macOS 签名归档、Windows NSIS 签名归档、Windows 安装器和固定文件名便携版。GitHub Actions 的三个构建 job 同时运行，`publish` 等待全部完成后生成统一 `release-assets`、`latest.json` 和 `SHA256SUMS`，然后只通过 SSH 发送版本号触发服务器拉取。

服务器上的 `qbank-release-puller.sh` 是一次性任务，不轮询 GitHub。它读取 `https://api.github.com/repos/qingye0312-cpu/question-bank/releases/tags/vX.Y.Z`，按 GitHub asset digest 和 Release 中的 `SHA256SUMS` 双重校验后调用安装脚本。代理只从 root-only 的 `/etc/qbank-release-puller.env` 读取，仅影响该任务访问 GitHub 的请求；不要把订阅地址或代理密钥写入仓库。

发布前在服务器准备：

- `/usr/local/sbin/qbank-release-puller`：仓库中的 `qbank-release-puller.sh`，root 拥有并执行。
- `/usr/local/sbin/qbank-install-desktop-update`：仓库中的 `install-desktop-update-release.sh`，root 拥有并执行。
- `/etc/qbank-release-puller.env`：root 拥有、`0600`，只放 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 和只读 `GITHUB_TOKEN`。私有仓库的 Release API 和资产下载需要这个 token；不要把 token 或订阅地址写入仓库。

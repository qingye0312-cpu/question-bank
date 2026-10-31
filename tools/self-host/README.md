# 自托管服务运行手册

服务源码位于 [`cloud/qbank-auth/`](../../cloud/qbank-auth/)，部署包由 `pnpm build:self-host` 生成。生产数据只在服务器 `QBANK_STORAGE_ROOT`，部署采用带版本目录的原子切换。

生产域名固定为 `qbank.acharrystar.top:8013`。客户端、桌面更新清单、下载页和 Caddy 检查均以该域名为默认值；部署脚本支持用 `QBANK_PUBLIC_DOMAIN`、`QBANK_DOMAIN` 或 `QBANK_FASTDOWNLOAD_HOSTNAME` 临时覆盖。

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

## 域名证书

公网只转发 TCP `8013`，`80/443` 不可达，因此证书使用 Let's Encrypt DNS-01，并通过阿里云 `dns_ali` 自动续期。证书和 DNS 凭据都不进入仓库。

服务器凭据文件固定为 `/etc/qbank-cert/acme.env`，必须由 root 拥有且权限为 `0600`，内容只包含：

```sh
Ali_Key="<RAM AccessKey ID>"
Ali_Secret="<RAM AccessKey Secret>"
```

首次部署可在 root-only 环境中通过 `QBANK_ALIYUN_ACCESS_KEY_ID` 和 `QBANK_ALIYUN_ACCESS_KEY_SECRET` 生成该文件。RAM 账号只授予该域名所需的 DNS 解析权限，不要使用主账号 AccessKey。

部署和续期入口：

```sh
QBANK_SSH_HOST=qbank-pve sh tools/self-host/deploy-domain-tls.sh
```

脚本会安装 Caddy 配置、证书安装器和每日续期任务。证书先写入新版本目录，再原子切换 `current`；Caddy 配置或 HTTPS 健康检查失败时恢复上一版配置。日常检查可运行：

```sh
node tools/self-host/check-public-tls.mjs https://qbank.acharrystar.top:8013
```

## 更新源

桌面更新源提供 `latest.json`、macOS 签名归档、Windows NSIS 签名归档、Windows 安装器和固定文件名便携版。GitHub Actions 的三个构建 job 同时运行，`publish` 等待全部完成后生成统一 `release-assets`、`latest.json` 和 `SHA256SUMS`，然后只通过 SSH 发送版本号触发服务器拉取。

发布后的自动检查地址为 `https://qbank.acharrystar.top:8013/v1/desktop/latest.json`；安装脚本会在切换 `latest.json` 后分别验证清单、macOS 更新归档和 Windows 更新归档，任一失败都会恢复上一版清单。

服务器上的 `qbank-release-puller.sh` 是一次性任务，不轮询 GitHub。它读取 `https://api.github.com/repos/qingye0312-cpu/question-bank/releases/tags/vX.Y.Z`，按 GitHub asset digest 和 Release 中的 `SHA256SUMS` 双重校验后调用安装脚本。代理只从 root-only 的 `/etc/qbank-release-puller.env` 读取，仅影响该任务访问 GitHub 的请求；不要把订阅地址或代理密钥写入仓库。

## 快速下载

快速下载页为 `https://qbank.acharrystar.top:8013/fastdownload`。第一次协商时浏览器和服务端都禁用 TURN，只尝试点对点 WebRTC；只有直连失败后才会关闭该连接并重新通过 `qbank-frps` 上的 TURN-over-TCP 建立加密回退通道。

TURN 默认监听 `8004/tcp`，UDP relay 使用 `8005-8011`。服务端不保存固定客户端密码，而是用 `/etc/turnserver-auth.secret` 生成一小时内有效的 HMAC 凭据。共享密钥只存在于 root-only 的 `/etc/qbank-fastdownload` 和 coturn 配置中，不进入仓库。

WAN 直连使用固定的服务端 UDP 端口 `42000-42010`；家庭路由器需要把该 UDP 端口段同端口转发到 `192.168.100.250`。未配置该转发时，远端客户端会明确显示并回退到 TURN。

重复部署入口：

```sh
sh tools/self-host/install-turnserver.sh
sh tools/self-host/deploy-fastdownload.sh
```

TURN 共享密钥由安装器保存在 `/etc/turnserver-auth.secret`；快速下载安装器会从现有服务配置中保留 TURN 设置。

发布前在服务器准备：

- `/usr/local/sbin/qbank-release-puller`：仓库中的 `qbank-release-puller.sh`，root 拥有并执行。
- `/usr/local/sbin/qbank-install-desktop-update`：仓库中的 `install-desktop-update-release.sh`，root 拥有并执行。
- `/etc/qbank-release-puller.env`：root 拥有、`0600`，只放 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 和只读 `GITHUB_TOKEN`。私有仓库的 Release API 和资产下载需要这个 token；不要把 token 或订阅地址写入仓库。

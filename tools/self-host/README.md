# Alpine 自托管 qbank-auth

这是题库唯一的服务端部署方式。服务运行在 SSH 管理的 Alpine 容器中，桌面端和小程序所有版本通过 HTTPS 访问同一套 API。业务数据只写入本机 `/var/lib/qbank-auth`，运行时仅依赖 Node.js 内置模块。

## 运行边界

- 公网 `8.141.124.97:8013` 只分流 SSH 和 HTTPS。FRP 转到容器 `127.0.0.1:8444`，sslh 按协议分到 SSH `22` 或 Caddy HTTPS `8443`；Caddy 反向代理到题库服务 `127.0.0.1:8080`。
- 桌面默认通过 `https://8.141.124.97:8013` 自动获取所有云端题库，使用内置 CA 公钥定向验证该服务。小程序开发版、体验版、正式版统一使用 `https://qbank.creart.top:8013`，通过公开证书验证服务，微信后台需配置相同的 `request` 合法域名。
- `/var/lib/qbank-auth` 是唯一业务数据目录，部署前应完整备份。
- `QBANK_UPLOAD_ENABLED` 和 `QBANK_SYNC_ENABLED` 控制上传与合并；没有状态文件时目录可读但 revision 为 0。

## 本地构建和部署

```sh
pnpm build:self-host
pnpm self-host:deploy
```

生成 `artifacts/self-host/qbank-auth-0.2.8.tar.gz`。部署脚本通过 SSH/SCP 将服务包放到 `/opt/qbank-auth/releases/`，解压到带时间戳的目录，再原子切换 `/opt/qbank-auth/current`，不会覆盖正在运行的目录。

## WebRTC 快速下载实验

实验下载页独立使用 `https://qbank.creart.top:8013/fastdowmload`。原 `/download` 页面、静态文件和部署脚本保持独立，不会被此功能覆盖。

用户明确点击直连按钮后，浏览器经 HTTPS 把 WebRTC offer 发给小主机；小主机从现有 Caddy 本机 HTTPS 文件路由读取当前安装包，再通过 DataChannel 尝试直传。Caddy／FRP 只承载页面、协商信息和普通 HTTPS 回退流量。网页将收到的文件按 SHA-256 校验后保存；直连失败时用户仍可选择普通 HTTPS 下载。

此功能要求自托管主机使用 Node.js 22 或更新版本。WebRTC 直连需要两端网络允许 UDP 和 NAT 打洞；当前实验使用 Cloudflare 公共 STUN，不部署 TURN。遇到严格 CGNAT、UDP 被阻断或 STUN 不可达时，应使用页面里的普通 HTTPS 下载。

首次准备独立 WebRTC 运行依赖并生成包：

```sh
pnpm --dir tools/self-host/fastdownload-server install --ignore-workspace
pnpm build:fastdownload
```

部署实验入口需明确运行 `pnpm self-host:fastdownload-deploy`。可通过 `QBANK_SSH_HOST`、`QBANK_FASTDOWNLOAD_HOSTNAME`、`QBANK_FASTDOWNLOAD_PUBLIC_ORIGIN` 和 `QBANK_FASTDOWNLOAD_STUN_URLS` 指定远端、Caddy 域名、网页公网来源和 STUN 列表。安装脚本只增加 `/fastdowmload` 的 Caddy 路由、单独启动本机 `127.0.0.1:8090` 服务，并在本机 HTTPS 检查失败时恢复 Caddy 配置。

## 环境变量

将受限的环境文件放在 `/etc/qbank-auth/qbank-auth.env`，权限 `0600`，可从 [cloud/qbank-auth/.env.example](../../cloud/qbank-auth/.env.example) 复制模板。至少配置会话密钥、题库目录、桌面维护者和最高权限账号，并增加：

```dotenv
QBANK_ENV_FILE=/etc/qbank-auth/qbank-auth.env
QBANK_STORAGE_ROOT=/var/lib/qbank-auth
QBANK_BIND_HOST=127.0.0.1
QBANK_PORT=8080
```

环境文件不纳入 Git，也不通过聊天传递。

## HTTPS 与 SSH 共用端口

配置模板见 [Caddyfile](Caddyfile) 和 [sslh.conf](sslh.conf)。Alpine 安装 `caddy`、`sslh`、`openssl` 后，将模板分别安装到 `/etc/caddy/Caddyfile`、`/etc/sslh.conf`。先在回环端口验证两种协议，保留 FRP 配置备份和独立的定时恢复脚本，最后把现有 `remotePort = 8013` 对应的 `localPort` 从 `22` 改为 `8444`。只有公网 HTTPS 验证和新 SSH 登录都成功，才取消恢复任务；不直接关闭 SSH 监听。

Caddy 使用内部 CA 自动签发、续期 IP 证书。公开根证书通过已验证的 SSH 连接取得，保存于 [qbank-pve-root-ca.pem](../../src-tauri/resources/qbank-pve-root-ca.pem)，随桌面编译；只对 [desktop-service.json](../../shared/desktop-service.json) 的完整 HTTPS origin 生效，其他 origin 使用系统信任。客户端仍校验 IP、证书有效期和签发链，不安装全局根证书，不允许跳过 TLS 校验。

公网 FRP／sslh 链路仅转发 TCP。Caddy 的 `servers { protocols h1 h2 }` 保留 HTTPS 上的 HTTP/1.1 和 HTTP/2，关闭此链路无法承载的 HTTP/3，避免向客户端通告内部 `8443` 的 UDP 备用入口。这不影响 TLS 1.2／1.3 或 SSH。[Caddy 协议配置](https://caddyserver.com/docs/caddyfile/options#protocols)。

根和中间证书私钥留在服务器 `/var/lib/caddy/.local/share/caddy/pki/`，必须与业务数据一起备份，禁止放入代码或客户端。叶子证书自动续期无需更新客户端；更换根 CA 时需要重新分发包含新公钥的桌面版。Caddy 管理接口仅监听回环 `2019`。

```sh
curl --cacert src-tauri/resources/qbank-pve-root-ca.pem https://8.141.124.97:8013/health
sh mac/scripts/env.sh cargo test --manifest-path src-tauri/Cargo.toml --test cloud_live -- --ignored --nocapture
```

第二条命令只读访问真实服务，将目录内所有题库应用到隔离临时数据库，核对题数和幂等，不写入日常数据库或远端题库。普通浏览器尚未信任这份私有 CA，小程序使用下述域名公开证书。[Caddy 内部证书说明](https://caddyserver.com/docs/automatic-https#local-https)、[sslh 协议分流说明](https://github.com/yrutschle/sslh)。

## 小程序域名共用 8013

客户端统一配置 `https://qbank.creart.top:8013`，微信 `request` 合法域名需填写相同地址。目录、版本检查、快照下载、手机号密码注册／登录、维护者申请和压缩上传均使用该入口。认证不依赖微信 AppID、AppSecret 或旧微信登录接口；旧身份仅保留为不可登录的归档数据。两端按完整云目录缓存所有题库，相同修订与摘要不重复下载，离线保留本地缓存。

**当前状态：证书和微信合法域名已配置；真机仍受公网 TLS 1.2 连接重置影响。** 开发者工具刷新“详情 → 项目配置 → 域名信息”后，在启用域名校验时成功读取目录及两库快照，并显示高级库 858 题；该结果不代表真机链路通过。真机原始错误为 `errno:600001 / net::ERR_CONNECTION_RESET`，详细对照见下方。原 IP HTTPS、SSH 和两库数据仍正常，未清理设备缓存或草稿。

[Caddyfile.domain](Caddyfile.domain) 已安装为 `/etc/caddy/qbank-domain.caddy` 并由主配置导入，Caddy 根据 SNI 区分域名公开证书与桌面 IP 的内部 CA 证书。证书位于 `/etc/caddy/certs/qbank.creart.top/versions/`，`current` 原子链接选择当前完整链与私钥；目录权限 `0750`、文件权限 `0640`、所有者 `root:caddy`。证书及私钥不进入仓库。

本次证书由 Let's Encrypt YR1 签发，覆盖 `qbank.creart.top`，有效期至 **2027-01-22 21:06:02（北京时间）**。按用户最新安排，**续期由供应商负责，本机未配置 DNS API 密钥或域名续期定时任务**。供应商签发新证书后，仍需将新证书安装到本容器并重载 Caddy；只在供应商处续期不会自动更新服务器文件。

服务器已安装 [install-domain-certificate.sh](install-domain-certificate.sh) 为 `/usr/local/sbin/qbank-install-domain-certificate`。用受限目录接收供应商交付文件后，在服务器执行：

```sh
qbank-install-domain-certificate /root/certificate-delivery/fullchain.pem /root/certificate-delivery/privkey.pem
```

该工具先验证主机名、完整信任链、剩余有效期和密钥匹配，再以独立目录保存证书对、原子切换链接、检查 Caddy 配置、热重载并检查域名 HTTPS。更新失败恢复上一证书版本；无效输入不会替换现有证书。部署后仍需从公网验证 `https://qbank.creart.top:8013/health`，内部健康检查不能代替公网验收。初次部署配置备份位于 `/var/backups/qbank-auth/20261024T1512-domain-tls`，仅 SSH／HTTPS 分流备份位于 `/var/backups/qbank-auth/20261024T1520-https-only`。

### 真机连接诊断

本次连接的 iPhone 17 Pro Max（iOS 27.0.1、微信 8.0.79、基础库 3.17.5）在开启、关闭 `enableHttp2` 时均返回 `ERR_CONNECTION_RESET`。只采集公开 TLS ClientHello 参数，观察到 SNI 为 `qbank.creart.top`，最高版本为 TLS 1.2。当前真机调试未勾选“不校验合法域名”。

| 路径 | TLS 1.2 | TLS 1.3 |
| --- | --- | --- |
| 容器内 Caddy `8443` | 证书验证及请求通过 | 证书验证及请求通过 |
| 容器内 sslh `8444` | 证书验证及双库目录通过 | 证书验证及双库目录通过 |
| 本机直连域名公网 `8013` | `ECONNRESET` | 证书验证通过，`/health` 返回 200 |
| 容器经公网域名回连 `8013` | `ECONNRESET` | 证书验证通过，`/health` 返回 200 |

失败握手已转发至 Caddy，但公网一侧在 Caddy 返回证书前终止了连接；内部两种 TLS 均正常。证据将问题定位到容器外的公网转发链路，尚不能确认是哪个入口组件或策略。域名接入、SNI 检查、备案拦截和 FRP 服务端配置需由公网转发机管理方核实。[阿里云连接重置排查说明](https://help.aliyun.com/zh/eip/support/faq-about-internet-connectivity)。

Caddy 通告内部 `8443` 备用入口的问题已单独修正并部署；公网 HTTP/2 实测 200，响应不再包含 `Alt-Svc`。配置备份为 `/var/backups/qbank-auth/20261024T160344Z-tcp-only`。此修正后公网 TLS 1.2 仍重置，真机再次请求 `/health` 也返回相同的 `ERR_CONNECTION_RESET`，不能把它当作真机故障已解决。小程序 TypeScript／共享资源检查及 5 项同步回归测试通过。

可在服务商调整前后执行只读对照，不使用本机代理、不跳过证书或主机名校验：

```sh
node tools/self-host/check-public-tls.mjs
```

脚本分别以 TLS 1.2、TLS 1.3 请求 `/health`，输出时间、远端地址、状态及错误码；任何一种未通过时退出码为 1。当前结果是一项失败、一项成功。服务商处理请求可直接使用：

> 请排查公网 `8.141.124.97:8013` 对 `qbank.creart.top` 的 TLS 1.2 连接重置。容器内 Caddy／sslh 的 TLS 1.2、1.3 均正常；公网 TLS 1.2 在 ClientHello 后被断开、未收到服务器证书，TLS 1.3 则通过证书验证并返回 200。请核查公网转发机的 FRP 服务端、域名接入／SNI 策略及上游网络限制，并确认是否需要办理备案或接入。需要保留 8013 的 SSH／HTTPS 共用方式，恢复 TLS 1.2 的正常透传。处理后应同时通过两种 TLS 检查，再进行微信真机同步验收。

真机登录、上传和双题库同步尚未通过，未为诊断执行真实上传或修改远端题目版本。

## 初次种入题库

先备份存储目录，再执行一次：

```sh
node /opt/qbank-auth/current/seed-bank.cjs /var/lib/qbank-auth/import/questions.json
```

种入脚本遇到同题库已有状态会拒绝覆盖。种入之后依次核对 `GET /health`、`GET /v1/catalog`、题库 manifest 和快照摘要。

## 题目质量状态修复

`repair-bank-status.cjs` 仅处理“没有答案且带问题说明，却被标为已核实”的矛盾数据。执行前备份数据，再以 `qbank` 用户运行：

```sh
su qbank -s /bin/sh -c 'node /opt/qbank-auth/current/repair-bank-status.cjs <bank_id> /var/lib/qbank-auth'
```

工具只把符合条件的题目状态改为 `needs_review`，不修改题干、选项或答案，不猜测答案。修复记录包含时间、题目 ID 和前后修订，保存为新的不可变版本；其他数据错误会中止写入，重复执行无变化时不增加版本。

## 维护者密钥

在本机执行 `node tools/create-maintainer.mjs <维护者ID> <bank_id> <upload,merge> [https://服务地址]` 生成密钥、授权条目和桌面导入证书。只把授权条目写入服务器环境，把证书文件安全分发到对应桌面；私钥不写入代码或聊天。

#!/bin/sh
set -eu

: "${QBANK_ARCHIVE:?请设置 QBANK_ARCHIVE}":
QUESTIONS="${QBANK_QUESTIONS:-}"
RELEASE_ROOT=/opt/qbank-auth/releases
CURRENT=/opt/qbank-auth/current
ENV_DIR=/etc/qbank-auth
ENV_FILE=$ENV_DIR/qbank-auth.env
DATA_ROOT=/var/lib/qbank-auth

if [ "$(id -u)" -ne 0 ]; then echo '请使用 root 执行安装'; exit 1; fi
apk add --no-cache nodejs ca-certificates >/dev/null
update-ca-certificates >/dev/null 2>&1 || true

getent group qbank >/dev/null 2>&1 || addgroup -S qbank
id qbank >/dev/null 2>&1 || adduser -S -D -H -s /sbin/nologin -G qbank qbank
mkdir -p "$RELEASE_ROOT" "$ENV_DIR" "$DATA_ROOT" /var/log/qbank-auth /run
chmod 700 "$ENV_DIR" "$DATA_ROOT"
touch /var/log/qbank-auth.log /var/log/qbank-auth.err
chown qbank:qbank /var/log/qbank-auth.log /var/log/qbank-auth.err
chmod 640 /var/log/qbank-auth.log /var/log/qbank-auth.err

stamp=$(date -u +%Y%m%dT%H%M%SZ)
release="$RELEASE_ROOT/$stamp"
mkdir -p "$release"
tar -xzf "$QBANK_ARCHIVE" -C "$release"
ln -s "$release" "$CURRENT.next"
node -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' "$CURRENT.next" "$CURRENT"

if [ ! -f "$ENV_FILE" ]; then
  session_secret=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  cat > "$ENV_FILE" <<EOF
# 由部署脚本创建；维护者名单和最高权限名单由管理员在本机编辑。
QBANK_ENV_FILE=$ENV_FILE
QBANK_STORAGE_ROOT=$DATA_ROOT
QBANK_BIND_HOST=127.0.0.1
QBANK_PORT=8080
QBANK_SESSION_SECRET=$session_secret
QBANK_AUTH_VERSION=1
QBANK_BANKS=[{"bank_id":"ad50971f-66af-51c2-bb0e-dc798b03b369","name":"HarmonyOS 初级认证"}]
QBANK_MAINTAINERS=[]
QBANK_CLOUD_CREATORS=[]
QBANK_ALLOWED_ORIGINS=[]
QBANK_UPLOAD_ENABLED=false
QBANK_SYNC_ENABLED=true
EOF
  chmod 600 "$ENV_FILE"
fi

# The service runs as qbank and must be able to read its private environment.
# Keep the directory and file inaccessible to other unprivileged users.
chown qbank:qbank "$ENV_DIR" "$ENV_FILE"
chmod 700 "$ENV_DIR"
chmod 600 "$ENV_FILE"

if [ -n "$QUESTIONS" ] && [ -f "$QUESTIONS" ] && [ ! -d "$DATA_ROOT/states/ad50971f-66af-51c2-bb0e-dc798b03b369" ]; then
  mkdir -p "$DATA_ROOT/import"
  cp "$QUESTIONS" "$DATA_ROOT/import/questions.json"
  node "$CURRENT/seed-bank.cjs" "$DATA_ROOT/import/questions.json" "$DATA_ROOT"
fi

cat > "$CURRENT/run.sh" <<'EOF'
#!/bin/sh
set -eu
export QBANK_ENV_FILE=/etc/qbank-auth/qbank-auth.env
exec /usr/bin/node /opt/qbank-auth/current/local-server.cjs
EOF
chmod 755 "$CURRENT/run.sh"

cat > /etc/init.d/qbank-auth <<'EOF'
#!/sbin/openrc-run
name="qbank-auth"
description="Question bank self-hosted API"
command="/opt/qbank-auth/current/run.sh"
command_user="qbank:qbank"
directory="/opt/qbank-auth/current"
pidfile="/run/${RC_SVCNAME}.pid"
command_background="yes"
output_log="/var/log/qbank-auth.log"
error_log="/var/log/qbank-auth.err"
depend() { need net; after firewall; }
EOF
chmod 755 /etc/init.d/qbank-auth

chown -R qbank:qbank "$DATA_ROOT" /var/log/qbank-auth
if [ -d /run/openrc ] && command -v rc-update >/dev/null 2>&1; then
  rc-update add qbank-auth default >/dev/null 2>&1 || true
  rc-service qbank-auth restart >/dev/null 2>&1 || true
fi

echo "installed release: $release"
echo "environment: $ENV_FILE"
echo "storage: $DATA_ROOT"
if command -v wget >/dev/null 2>&1; then
  sleep 1
  wget -qO- http://127.0.0.1:8080/health || true
  echo
fi

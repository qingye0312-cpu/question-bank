#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
HOST="${QBANK_SSH_HOST:-qbank-pve}"
VERSION=$(node -p "require('./cloud/qbank-auth/package.json').version")
ARCHIVE="artifacts/self-host/qbank-auth-$VERSION.tar.gz"
REMOTE_ARCHIVE="/tmp/qbank-auth-$VERSION.tar.gz"
REMOTE_QUESTIONS="/tmp/qbank-questions.json"

pnpm build:self-host
scp "$ARCHIVE" "$HOST:$REMOTE_ARCHIVE"
scp tools/mobile-index/sources/basic/questions.jsonl "$HOST:$REMOTE_QUESTIONS"
ssh "$HOST" "QBANK_ARCHIVE=$REMOTE_ARCHIVE QBANK_QUESTIONS=$REMOTE_QUESTIONS sh -s" < tools/self-host/install-alpine.sh

#!/bin/sh
set -eu

HOST="${QBANK_SSH_HOST:-qbank-pve}"
ARCHIVE="artifacts/self-host/qbank-auth-0.2.7.tar.gz"
REMOTE_ARCHIVE="/tmp/qbank-auth-0.2.7.tar.gz"
REMOTE_QUESTIONS="/tmp/qbank-questions.json"

pnpm build:self-host
scp "$ARCHIVE" "$HOST:$REMOTE_ARCHIVE"
scp miniprogram/miniprogram/data/questions.json "$HOST:$REMOTE_QUESTIONS"
ssh "$HOST" "QBANK_ARCHIVE=$REMOTE_ARCHIVE QBANK_QUESTIONS=$REMOTE_QUESTIONS sh -s" < tools/self-host/install-alpine.sh

#!/bin/sh
set -eu

HOST="${QBANK_SSH_HOST:-qbank-pve}"
ARCHIVE="artifacts/self-host/qbank-fastdownload-0.1.0.tar.gz"
REMOTE_ARCHIVE=/tmp/qbank-fastdownload-0.1.0.tar.gz

sh mac/scripts/env.sh node scripts/build-fastdownload.mjs
scp "$ARCHIVE" "$HOST:$REMOTE_ARCHIVE"
ssh "$HOST" "QBANK_FASTDOWNLOAD_ARCHIVE=$REMOTE_ARCHIVE sh -s" < tools/self-host/install-fastdownload.sh
ssh "$HOST" "rm -f $REMOTE_ARCHIVE"

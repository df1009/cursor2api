#!/bin/bash
set -e
SSH="ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no df@139.224.68.9"
REPO="https://YOUR_TOKEN@github.com/df1009/cursor2api.git"
REMOTE_DIR="/home/df/cursor2api_proxy"

echo "[1] 拉取代码..."
$SSH "
  if [ -d $REMOTE_DIR/.git ]; then
    cd $REMOTE_DIR && git fetch origin && git checkout proxy && git reset --hard origin/proxy
  else
    git clone -b proxy $REPO $REMOTE_DIR
  fi
"

echo "[2] 安装依赖+编译..."
$SSH "cd $REMOTE_DIR && npm install && npm run build"
echo "代码同步+编译完成"

#!/bin/bash
# 备用服务器一键部署脚本
# 执行: bash scripts/deploy-backup-server.sh
set -e
DIR="$(dirname "$0")"
SSH="ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no df@139.224.68.9"

bash "$DIR/1-sync.sh"
bash "$DIR/2-config.sh"
$SSH 'python3 /home/df/cursor2api_proxy/scripts/3-mihomo.py'
bash "$DIR/4-systemd.sh"

echo ""
echo "====== 备用服务器部署完成 ======"
echo "服务地址: http://139.224.68.9:3011"
echo "健康检查: http://139.224.68.9:3011/health"
echo "代理状态: http://139.224.68.9:3011/proxy-status"

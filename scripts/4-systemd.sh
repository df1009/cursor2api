#!/bin/bash
set -e
SSH="ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no df@139.224.68.9"

echo "[4] 写 systemd 服务..."
$SSH 'sudo tee /etc/systemd/system/mihomo-proxy-pool.service > /dev/null' << 'UNIT'
[Unit]
Description=Mihomo Proxy Pool
After=network.target

[Service]
Type=simple
User=df
WorkingDirectory=/home/df/clash/proxy-pool-run
ExecStart=/home/df/clash/mihomo -d /home/df/clash/proxy-pool-run
Restart=always
RestartSec=5
StandardOutput=append:/home/df/clash/proxy-pool.log
StandardError=append:/home/df/clash/proxy-pool.log

[Install]
WantedBy=multi-user.target
UNIT

$SSH 'sudo tee /etc/systemd/system/cursor2api-proxy.service > /dev/null' << 'UNIT'
[Unit]
Description=Cursor2API Proxy
After=network.target mihomo-proxy-pool.service

[Service]
Type=simple
User=df
WorkingDirectory=/home/df/cursor2api_proxy
Environment=PORT=3011
ExecStart=/usr/bin/node /home/df/cursor2api_proxy/dist/index.js
Restart=always
RestartSec=5
StandardOutput=append:/home/df/cursor2api_proxy/run.log
StandardError=append:/home/df/cursor2api_proxy/run.log

[Install]
WantedBy=multi-user.target
UNIT

$SSH 'sudo systemctl daemon-reload && sudo systemctl enable mihomo-proxy-pool cursor2api-proxy'
echo "[5] 启动服务..."
$SSH 'sudo systemctl restart mihomo-proxy-pool && sleep 3 && sudo systemctl restart cursor2api-proxy'
echo "[6] 验证..."
sleep 5
$SSH '
echo "--- mihomo-proxy-pool:"
sudo systemctl is-active mihomo-proxy-pool
echo "--- cursor2api-proxy:"
sudo systemctl is-active cursor2api-proxy
echo "--- 端口验证:"
for p in 18001 18002 18003 18004 18005; do
  r=$(curl -s --max-time 5 --proxy http://127.0.0.1:$p https://www.gstatic.com/generate_204 -o /dev/null -w "%{http_code}")
  echo "  $p: $r"
done
echo "--- 健康检查:"
curl -s http://localhost:3011/health
'

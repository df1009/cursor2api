#!/bin/bash
# deploy-server.sh - 服务器代理池部署脚本
# 执行前确认：bash scripts/deploy-server.sh

set -e
SSH_HOST="df@8.148.64.84"
SSH_KEY="$HOME/.ssh/id_ed25519"
SSH_PROXY="-o ProxyCommand='nc -x 127.0.0.1:1080 %h %p'"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ProxyCommand=\"nc -x 127.0.0.1:1080 %h %p\" $SSH_HOST"
SCP="scp -i $SSH_KEY -o StrictHostKeyChecking=no -o ProxyCommand=\"nc -x 127.0.0.1:1080 %h %p\""

echo "=== Step 1: 生成服务器代理池配置 ==="
$SSH 'python3 << EOF
import re

with open("/home/df/clash/config.yaml", "r") as f:
    content = f.read()

targets = [
    ("\U0001f1ed\U0001f1f0|\u9999\u6e2f-\u8fdb\u9636IEPL 01", 18001),
    ("\U0001f1ed\U0001f1f0|\u9999\u6e2f-\u8fdb\u9636IEPL 03", 18002),
    ("\U0001f1ed\U0001f1f0|\u9999\u6e2f-IEPL 03",     18003),
    ("\U0001f1ed\U0001f1f0|\u9999\u6e2f-IEPL 01",     18004),
    ("\U0001f1ed\U0001f1f0|\u9999\u6e2f-IEPL 02",     18005),
    ("\U0001f1ed\U0001f1f0|\u9999\u6e2f-\u8fdb\u9636IEPL 02", 18006),
    ("\U0001f1f8\U0001f1ec|\u65b0\u52a0\u5761-\u8fdb\u9636IEPL 02", 18007),
    ("\U0001f1f8\U0001f1ec|\u65b0\u52a0\u5761-IEPL 02",   18008),
    ("\U0001f1f8\U0001f1ec|\u65b0\u52a0\u5761-IEPL 03",   18009),
    ("\U0001f1f8\U0001f1ec|\u65b0\u52a0\u5761-\u8fdb\u9636IEPL 03", 18010),
    ("\U0001f1ef\U0001f1f5|\u65e5\u672c-IEPL 01",     18011),
    ("\U0001f1f8\U0001f1ec|\u65b0\u52a0\u5761-\u8fdb\u9636IEPL 01", 18012),
]

proxy_map = {}
for line in content.split("\n"):
    stripped = line.strip()
    if not (stripped.startswith("- {") and "type: trojan" in stripped):
        continue
    for name, port in targets:
        if f"name: \x27{name}\x27" in stripped or f"name: {name}," in stripped:
            proxy_map[name] = "  " + stripped
            break

proxies_block = "\n".join(proxy_map[name] for name, _ in targets if name in proxy_map)

listeners_lines = []
for name, port in targets:
    if name not in proxy_map:
        continue
    listeners_lines.append(f"  - name: proxy-{port}")
    listeners_lines.append(f"    type: mixed")
    listeners_lines.append(f"    port: {port}")
    listeners_lines.append(f"    proxy: \x27{name}\x27")
listeners_block = "\n".join(listeners_lines)

config = f"""# mihomo proxy-pool config
mixed-port: 17890
allow-lan: false
mode: global
log-level: warning
external-controller: 127.0.0.1:19090

dns:
  enable: true
  ipv6: false
  nameserver:
    - 223.5.5.5
    - 119.29.29.29

proxies:
{proxies_block}

proxy-groups:
  - name: GLOBAL
    type: select
    proxies:
{chr(10).join(f\"      - \x27{name}\x27\" for name, _ in targets if name in proxy_map)}

rules:
  - MATCH,GLOBAL

listeners:
{listeners_block}
"""

with open("/home/df/clash/proxy-pool.yaml", "w") as f:
    f.write(config)
print(f"生成完成，节点数: {len(proxy_map)}")
EOF'

echo "=== Step 2: 启动 mihomo proxy-pool 实例 ==="
$SSH 'pkill -f "mihomo -d /home/df/clash/proxy-pool" 2>/dev/null || true
mkdir -p /home/df/clash/proxy-pool-run
cp /home/df/clash/proxy-pool.yaml /home/df/clash/proxy-pool-run/config.yaml
cp /home/df/clash/Country.mmdb /home/df/clash/proxy-pool-run/ 2>/dev/null || true
nohup /home/df/clash/mihomo -d /home/df/clash/proxy-pool-run > /home/df/clash/proxy-pool.log 2>&1 &
echo "PID: $!"
sleep 3
curl -s http://127.0.0.1:19090/version'

echo "=== Step 3: 写 systemd 服务文件 ==="
$SSH 'cat > /tmp/mihomo-proxy-pool.service << UNIT
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
sudo mv /tmp/mihomo-proxy-pool.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable mihomo-proxy-pool
sudo systemctl restart mihomo-proxy-pool
systemctl is-active mihomo-proxy-pool'

echo "=== Step 4: 验证端口 ==="
$SSH 'sleep 3 && for port in 18001 18002 18003 18004 18005; do
    result=$(curl -s --max-time 8 --proxy http://127.0.0.1:$port https://www.gstatic.com/generate_204 -o /dev/null -w "%{http_code}")
    echo "$port: $result"
done'

echo "=== 部署完成 ==="

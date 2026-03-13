#!/bin/bash
set -e
SERVER="df@139.224.68.9"
SSH="ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no"

echo "[3] 写服务器 config.yaml..."
$SSH $SERVER 'cat > /home/df/cursor2api_proxy/config.yaml' << 'CFGEOF'
port: 3011
timeout: 120
cursor_model: "anthropic/claude-opus-4.6"
fingerprint:
  user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
proxy_pool:
  enabled: true
  ttl_sec: 60
  per_proxy_timeout_sec: 10
  max_failures: 3
  cooldown_base_sec: 120
  max_cooldown_sec: 1800
  max_proxy_retries: 3
  fallback_direct: true
  proxies:
    - { url: "http://127.0.0.1:18001", name: "香港-进阶IEPL 01" }
    - { url: "http://127.0.0.1:18002", name: "香港-进阶IEPL 03" }
    - { url: "http://127.0.0.1:18003", name: "香港-IEPL 03" }
    - { url: "http://127.0.0.1:18004", name: "香港-IEPL 01" }
    - { url: "http://127.0.0.1:18005", name: "香港-IEPL 02" }
    - { url: "http://127.0.0.1:18006", name: "香港-进阶IEPL 02" }
    - { url: "http://127.0.0.1:18007", name: "新加坡-进阶IEPL 02" }
    - { url: "http://127.0.0.1:18008", name: "新加坡-IEPL 02" }
    - { url: "http://127.0.0.1:18009", name: "新加坡-IEPL 03" }
    - { url: "http://127.0.0.1:18010", name: "新加坡-进阶IEPL 03" }
    - { url: "http://127.0.0.1:18011", name: "日本-IEPL 01" }
    - { url: "http://127.0.0.1:18012", name: "新加坡-进阶IEPL 01" }
    - { url: "http://127.0.0.1:18013", name: "澳门-IEPL 02" }
    - { url: "http://127.0.0.1:18014", name: "台湾家宽-IEPL 03" }
    - { url: "http://127.0.0.1:18015", name: "台湾-进阶IEPL 01" }
    - { url: "http://127.0.0.1:18016", name: "台湾-进阶IEPL 02" }
    - { url: "http://127.0.0.1:18017", name: "台湾-IEPL 01" }
    - { url: "http://127.0.0.1:18018", name: "韩国家宽-IEPL 01" }
    - { url: "http://127.0.0.1:18019", name: "香港家宽-IEPL 02" }
    - { url: "http://127.0.0.1:18020", name: "香港家宽-IEPL 01" }
    - { url: "http://127.0.0.1:18021", name: "新加坡-IEPL 01" }
    - { url: "http://127.0.0.1:18022", name: "马来西亚-IEPL 01" }
    - { url: "http://127.0.0.1:18023", name: "越南-IEPL 02" }
    - { url: "http://127.0.0.1:18024", name: "马来西亚-IEPL 03" }
    - { url: "http://127.0.0.1:18025", name: "马来西亚-IEPL 02" }
    - { url: "http://127.0.0.1:18026", name: "越南家宽-IEPL 02" }
    - { url: "http://127.0.0.1:18027", name: "泰国-IEPL 01" }
    - { url: "http://127.0.0.1:18028", name: "日本-IEPL 02" }
    - { url: "http://127.0.0.1:18029", name: "泰国-IEPL 02" }
    - { url: "http://127.0.0.1:18030", name: "越南家宽-IEPL 01" }
    - { url: "http://127.0.0.1:18031", name: "日本原生-IEPL 01" }
    - { url: "http://127.0.0.1:18032", name: "日本原生-IEPL 02" }
CFGEOF
echo "config.yaml 写入完成"

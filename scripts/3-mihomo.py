#!/usr/bin/env python3
# 在服务器上执行：python3 3-mihomo.py
import re

CLASH_CFG = '/home/df/clash/config.yaml'
POOL_DIR = '/home/df/clash/proxy-pool-run'

targets = [
    ('🇭🇰|香港-进阶IEPL 01', 18001), ('🇭🇰|香港-进阶IEPL 03', 18002),
    ('🇭🇰|香港-IEPL 03', 18003), ('🇭🇰|香港-IEPL 01', 18004),
    ('🇭🇰|香港-IEPL 02', 18005), ('🇭🇰|香港-进阶IEPL 02', 18006),
    ('🇸🇬|新加坡-进阶IEPL 02', 18007), ('🇸🇬|新加坡-IEPL 02', 18008),
    ('🇸🇬|新加坡-IEPL 03', 18009), ('🇸🇬|新加坡-进阶IEPL 03', 18010),
    ('🇯🇵|日本-IEPL 01', 18011), ('🇸🇬|新加坡-进阶IEPL 01', 18012),
    ('🇲🇴|澳门-IEPL 02', 18013), ('🇹🇼|台湾家宽-IEPL 03', 18014),
    ('🇹🇼|台湾-进阶IEPL 01', 18015), ('🇹🇼|台湾-进阶IEPL 02', 18016),
    ('🇹🇼|台湾-IEPL 01', 18017), ('🇰🇷|韩国家宽-IEPL 01', 18018),
    ('🇭🇰|香港家宽-IEPL 02', 18019), ('🇭🇰|香港家宽-IEPL 01', 18020),
    ('🇸🇬|新加坡-IEPL 01', 18021), ('🇲🇾|马来西亚-IEPL 01', 18022),
    ('🇻🇳|越南-IEPL 02', 18023), ('🇲🇾|马来西亚-IEPL 03', 18024),
    ('🇲🇾|马来西亚-IEPL 02', 18025), ('🇻🇳|越南家宽-IEPL 02', 18026),
    ('🇹🇭|泰国-IEPL 01', 18027), ('🇯🇵|日本-IEPL 02', 18028),
    ('🇹🇭|泰国-IEPL 02', 18029), ('🇻🇳|越南家宽-IEPL 01', 18030),
    ('🇯🇵|日本原生-IEPL 01', 18031), ('🇯🇵|日本原生-IEPL 02', 18032),
]

import os
os.makedirs(POOL_DIR, exist_ok=True)

with open(CLASH_CFG, 'r') as f:
    content = f.read()

proxy_map = {}
for line in content.split('\n'):
    s = line.strip()
    if not (s.startswith('- {') and 'type: trojan' in s):
        continue
    for name, port in targets:
        if f"name: '{name}'" in s or f'name: {name},' in s:
            proxy_map[name] = '  ' + s
            break

L = ['# mihomo proxy-pool', 'mixed-port: 17890', 'allow-lan: false',
     'mode: global', 'log-level: warning',
     "external-controller: '127.0.0.1:19090'",
     '', 'dns:', '  enable: true', '  ipv6: false', '  nameserver:',
     '    - 223.5.5.5', '    - 119.29.29.29', '', 'proxies:']
for n, p in targets:
    if n in proxy_map: L.append(proxy_map[n])
L += ['', 'proxy-groups:', '  - name: GLOBAL', '    type: select', '    proxies:']
for n, p in targets:
    if n in proxy_map: L.append(f"      - '{n}'")
L += ['', 'rules:', '  - MATCH,GLOBAL', '', 'listeners:']
for n, p in targets:
    if n not in proxy_map: continue
    L += [f'  - name: proxy-{p}', f'    type: mixed', f'    port: {p}', f"    proxy: '{n}'"]

out = POOL_DIR + '/config.yaml'
with open(out, 'w') as f:
    f.write('\n'.join(L) + '\n')
print(f'mihomo配置生成完成，节点: {len(proxy_map)}，输出: {out}')

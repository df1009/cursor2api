import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { AppConfig, ProxyPoolConfig } from './types.js';

let config: AppConfig;

export function getConfig(): AppConfig {
    if (config) return config;

    // 默认配置
    config = {
        port: 3010,
        timeout: 120,
        cursorModel: 'anthropic/claude-sonnet-4.6',
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
    };

    // 从 config.yaml 加载
    if (existsSync('config.yaml')) {
        try {
            const raw = readFileSync('config.yaml', 'utf-8');
            const yaml = parseYaml(raw);
            if (yaml.port) config.port = yaml.port;
            if (yaml.timeout) config.timeout = yaml.timeout;
            if (yaml.proxy) config.proxy = yaml.proxy;
            if (yaml.cursor_model) config.cursorModel = yaml.cursor_model;
            if (yaml.fingerprint) {
                if (yaml.fingerprint.user_agent) config.fingerprint.userAgent = yaml.fingerprint.user_agent;
            }
            if (yaml.vision) {
                config.vision = {
                    enabled: yaml.vision.enabled !== false,
                    mode: yaml.vision.mode || 'ocr',
                    baseUrl: yaml.vision.base_url || 'https://api.openai.com/v1/chat/completions',
                    apiKey: yaml.vision.api_key || '',
                    model: yaml.vision.model || 'gpt-4o-mini',
                };
            }
            if (yaml.proxy_pool && yaml.proxy_pool.enabled !== false) {
                const pp = yaml.proxy_pool;
                const proxyList: Array<{ url: string; name: string }> = [];
                if (Array.isArray(pp.proxies)) {
                    for (const p of pp.proxies) {
                        if (typeof p === 'string') {
                            proxyList.push({ url: p, name: p });
                        } else if (p && typeof p.url === 'string') {
                            proxyList.push({ url: p.url, name: p.name || p.url });
                        }
                    }
                }
                const poolConfig: ProxyPoolConfig = {
                    enabled: true,
                    proxies: proxyList,
                    ttlSec: pp.ttl_sec ?? 60,
                    perProxyTimeoutSec: pp.per_proxy_timeout_sec ?? 10,
                    maxFailures: pp.max_failures ?? 3,
                    cooldownBaseSec: pp.cooldown_base_sec ?? 120,
                    maxCooldownSec: pp.max_cooldown_sec ?? 1800,
                    maxProxyRetries: pp.max_proxy_retries ?? 3,
                    fallbackDirect: pp.fallback_direct !== false,
                };
                if (proxyList.length > 0) {
                    config.proxyPool = poolConfig;
                }
            }
        } catch (e) {
            console.warn('[Config] 读取 config.yaml 失败:', e);
        }
    }

    // 环境变量覆盖
    if (process.env.PORT) config.port = parseInt(process.env.PORT);
    if (process.env.TIMEOUT) config.timeout = parseInt(process.env.TIMEOUT);
    if (process.env.PROXY) config.proxy = process.env.PROXY;
    if (process.env.CURSOR_MODEL) config.cursorModel = process.env.CURSOR_MODEL;

    // 从 base64 FP 环境变量解析指纹
    if (process.env.FP) {
        try {
            const fp = JSON.parse(Buffer.from(process.env.FP, 'base64').toString());
            if (fp.userAgent) config.fingerprint.userAgent = fp.userAgent;
        } catch (e) {
            console.warn('[Config] 解析 FP 环境变量失败:', e);
        }
    }

    return config;
}

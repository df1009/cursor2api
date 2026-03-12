/**
 * cursor-client.ts - Cursor API 客户端
 *
 * 职责：
 * 1. 发送请求到 https://cursor.com/api/chat（带 Chrome TLS 指纹模拟 headers）
 * 2. 流式解析 SSE 响应
 * 3. 自动重试（最多 2 次）
 *
 * 注：x-is-human token 验证已被 Cursor 停用，直接发送空字符串即可。
 */

import type { CursorChatRequest, CursorSSEEvent } from './types.js';
import { getConfig } from './config.js';
import { ProxyAgent } from 'undici';

const CURSOR_CHAT_API = 'https://cursor.com/api/chat';

// ==================== Proxy 池管理（请求级隔离，不切换 Clash 全局节点）====================

const proxyPool = {
    active: [] as string[],    // 可用 proxy URL
    inactive: [] as string[],  // 不可用（待恢复）
    initialized: false,
    recovering: false,
};
let proxyIndex = 0;

/**
 * 初始化 proxy 池（从 config.proxies 读取）
 * 首次调用时初始化，后续直接用已有池
 */
function ensureProxyPool(): void {
    if (proxyPool.initialized) return;
    const config = getConfig();
    const proxies = config.proxies || (config.proxy ? [config.proxy] : []);
    proxyPool.active = [...proxies];
    proxyPool.initialized = true;
    console.log(`[ProxyPool] 初始化: ${proxyPool.active.length} 个代理`);
    // 每 60s 后台恢复检测
    if (proxyPool.active.length > 1) {
        setInterval(() => recoverProxies(), 60 * 1000);
    }
}

/**
 * 轮询取下一个可用 proxy
 * 若池为空（全部不可用），降级到原始列表第一个
 */
function getNextProxy(): string | undefined {
    ensureProxyPool();
    if (proxyPool.active.length === 0) {
        // 全部下线，降级用原始配置第一个
        const config = getConfig();
        const fallback = config.proxies?.[0] || config.proxy;
        if (fallback) console.warn(`[ProxyPool] 全部下线，降级使用: ${fallback}`);
        return fallback;
    }
    const proxy = proxyPool.active[proxyIndex % proxyPool.active.length];
    proxyIndex++;
    console.log(`[ProxyPool] 使用代理 [${proxyIndex}/${proxyPool.active.length} active]: ${proxy}`);
    return proxy;
}

/**
 * 标记 proxy 不可用，移入 inactive
 */
function markProxyInactive(proxyUrl: string): void {
    const idx = proxyPool.active.indexOf(proxyUrl);
    if (idx !== -1) {
        proxyPool.active.splice(idx, 1);
        if (!proxyPool.inactive.includes(proxyUrl)) {
            proxyPool.inactive.push(proxyUrl);
        }
        console.warn(`[ProxyPool] 下线: ${proxyUrl}，剩余可用: ${proxyPool.active.length}`);
    }
}

/**
 * 后台恢复检测：对 inactive 列表里的 proxy 发 HEAD 请求，通了就移回 active
 */
async function recoverProxies(): Promise<void> {
    if (proxyPool.recovering || proxyPool.inactive.length === 0) return;
    proxyPool.recovering = true;
    const recovered: string[] = [];
    for (const proxyUrl of [...proxyPool.inactive]) {
        try {
            const resp = await fetch('https://www.google.com', {
                method: 'HEAD',
                signal: AbortSignal.timeout(5000),
                dispatcher: new ProxyAgent(proxyUrl),
            } as RequestInit & { dispatcher?: unknown });
            if (resp.ok || resp.status < 500) {
                recovered.push(proxyUrl);
                console.log(`[ProxyPool] 恢复: ${proxyUrl}`);
            }
        } catch { /* 还不通，跳过 */ }
    }
    if (recovered.length > 0) {
        proxyPool.inactive = proxyPool.inactive.filter(p => !recovered.includes(p));
        proxyPool.active.push(...recovered);
        console.log(`[ProxyPool] 恢复 ${recovered.length} 个代理，当前可用: ${proxyPool.active.length}`);
    }
    proxyPool.recovering = false;
}

// Chrome 浏览器请求头模拟
function getChromeHeaders(): Record<string, string> {
    const config = getConfig();
    return {
        'Content-Type': 'application/json',
        'sec-ch-ua-platform': '"Windows"',
        'x-path': '/api/chat',
        'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        'x-method': 'POST',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-platform-version': '"19.0.0"',
        'origin': 'https://cursor.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': 'https://cursor.com/',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'priority': 'u=1, i',
        'user-agent': config.fingerprint.userAgent,
        'x-is-human': '',  // Cursor 不再校验此字段
    };
}

// ==================== API 请求 ====================

/**
 * 发送请求到 Cursor /api/chat 并以流式方式处理响应（带重试）
 */
export async function sendCursorRequest(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
): Promise<void> {
    const maxRetries = 2;
    let lastProxyUrl: string | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            lastProxyUrl = await sendCursorRequestInner(req, onChunk);
            return;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Cursor] 请求失败 (${attempt}/${maxRetries}): ${msg}`);
            // 请求失败，将当前 proxy 标记下线
            if (lastProxyUrl) markProxyInactive(lastProxyUrl);
            if (attempt < maxRetries) {
                console.log(`[Cursor] 2s 后重试...`);
                await new Promise(r => setTimeout(r, 2000));
            } else {
                throw err;
            }
        }
    }
}

async function sendCursorRequestInner(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
): Promise<string | undefined> {
    const headers = getChromeHeaders();

    console.log(`[Cursor] 发送请求: model=${req.model}, messages=${req.messages.length}`);

    const config = getConfig();
    const controller = new AbortController();

    // ★ 空闲超时（Idle Timeout）：用读取活动检测替换固定总时长超时。
    // 每次收到新数据时重置计时器，只有在指定时间内完全无数据到达时才中断。
    // 这样长输出（如写长文章、大量工具调用）不会因总时长超限被误杀。
    const IDLE_TIMEOUT_MS = config.timeout * 1000; // 复用 timeout 配置作为空闲超时阈值
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            console.warn(`[Cursor] 空闲超时（${config.timeout}s 无新数据），中止请求`);
            controller.abort();
        }, IDLE_TIMEOUT_MS);
    };

    // 启动初始计时（等待服务器开始响应）
    resetIdleTimer();

    // ★ 请求级代理隔离：每个请求独立取一个 proxy，轮询 proxies 列表，不切换 Clash 全局节点
    const proxyUrl = getNextProxy();
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: controller.signal,
    };
    if (proxyUrl) {
        fetchOptions.dispatcher = new ProxyAgent(proxyUrl);
    }

    try {
        const resp = await fetch(CURSOR_CHAT_API, fetchOptions);

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Cursor API 错误: HTTP ${resp.status} - ${body}`);
        }

        if (!resp.body) {
            throw new Error('Cursor API 响应无 body');
        }

        // 流式读取 SSE 响应
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // 每次收到数据就重置空闲计时器
            resetIdleTimer();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data) continue;

                try {
                    const event: CursorSSEEvent = JSON.parse(data);
                    onChunk(event);
                } catch {
                    // 非 JSON 数据，忽略
                }
            }
        }

        // 处理剩余 buffer
        if (buffer.startsWith('data: ')) {
            const data = buffer.slice(6).trim();
            if (data) {
                try {
                    const event: CursorSSEEvent = JSON.parse(data);
                    onChunk(event);
                } catch { /* ignore */ }
            }
        }
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }
    return proxyUrl;
}

/**
 * 发送非流式请求，收集完整响应
 */
export async function sendCursorRequestFull(req: CursorChatRequest): Promise<string> {
    let fullText = '';
    await sendCursorRequest(req, (event) => {
        if (event.type === 'text-delta' && event.delta) {
            fullText += event.delta;
        }
    });
    return fullText;
}

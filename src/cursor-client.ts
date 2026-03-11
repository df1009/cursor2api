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

// ==================== 代理轮询 ====================
let proxyIndex = 0;
let clashNodes: string[] = [];
let clashNodesLoaded = false;

async function loadClashNodes(clashApi: string, group: string): Promise<string[]> {
    try {
        const resp = await fetch(`${clashApi}/proxies/${encodeURIComponent(group)}`);
        if (!resp.ok) return [];
        const data = await resp.json() as { all: string[] };
        // 过滤掉非节点项
        const skip = ['自动选择', '剩余流量', '距离下次重置', '套餐到期', 'DIRECT', 'REJECT'];
        return (data.all || []).filter((n: string) => !skip.some(s => n.includes(s)));
    } catch { return []; }
}

async function switchClashNode(clashApi: string, group: string, node: string): Promise<void> {
    try {
        await fetch(`${clashApi}/proxies/${encodeURIComponent(group)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: node }),
        });
        console.log(`[Proxy] 切换节点: ${node}`);
    } catch (e) {
        console.warn(`[Proxy] 切换节点失败: ${e}`);
    }
}

function getNextProxy(): string | undefined {
    const config = getConfig();
    const proxies = config.proxies;
    if (proxies && proxies.length > 0) {
        const proxy = proxies[proxyIndex % proxies.length];
        proxyIndex++;
        console.log(`[Proxy] 使用代理 [${proxyIndex}/${proxies.length}]: ${proxy}`);
        return proxy;
    }
    if (config.proxy) return config.proxy;
    return undefined;
}

async function rotateClashNode(): Promise<void> {
    const config = getConfig();
    if (!config.clashApi || !config.clashGroup) return;
    if (!clashNodesLoaded) {
        clashNodes = await loadClashNodes(config.clashApi, config.clashGroup);
        clashNodesLoaded = true;
        console.log(`[Proxy] 加载 Clash 节点 ${clashNodes.length} 个`);
    }
    if (clashNodes.length === 0) return;
    const node = clashNodes[proxyIndex % clashNodes.length];
    proxyIndex++;
    await switchClashNode(config.clashApi, config.clashGroup, node);
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
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await sendCursorRequestInner(req, onChunk);
            return;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Cursor] 请求失败 (${attempt}/${maxRetries}): ${msg}`);
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
): Promise<void> {
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

    await rotateClashNode();
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

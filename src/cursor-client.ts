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
import { getProxyFetchOptions } from './proxy-agent.js';

import { getProxyPool } from './proxy-pool.js';

const CURSOR_CHAT_API = 'https://cursor.com/api/chat';

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
 * 判断是否是代理本身的网络层故障（需要标记代理失败、换代理重试）
 * 注意：429/aborted 是上游限流或服务端断连，代理本身是好的，不标记代理失败
 */
function isProxyNetworkError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return (
        msg.includes('ECONNREFUSED') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('UND_ERR_SOCKET') ||
        msg.includes('UND_ERR_CONNECT_TIMEOUT') ||
        msg.includes('UND_ERR_HEADERS_TIMEOUT') ||
        (msg.includes('fetch failed') && !msg.includes('aborted'))
    );
}

/**
 * 判断是否需要换代理重试（代理网络故障 OR 上游限流）
 * 换代理重试，但不标记当前代理为失败
 */
function shouldRetryWithProxy(err: unknown, httpStatus?: number): boolean {
    if (httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return true;
    const msg = err instanceof Error ? err.message : String(err);
    // Cursor 服务端主动断连（This operation was aborted）—— 换代理重试但不计失败
    if (msg.includes('aborted') || msg.includes('This operation was aborted')) return true;
    return isProxyNetworkError(err);
}

/**
 * 发送请求到 Cursor /api/chat 并以流式方式处理响应（带代理池重试）
 */
export async function sendCursorRequest(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    externalSignal?: AbortSignal,
): Promise<void> {
    const pool = getProxyPool();
    const config = getConfig();
    const maxRetries = pool ? config.proxyPool!.maxProxyRetries : 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const { url: proxyUrl, signal: proxySignal } = pool
            ? pool.acquire()
            : { url: null, signal: null };

        try {
            await sendCursorRequestInner(req, onChunk, externalSignal);

            await sendCursorRequestInner(req, onChunk, proxyUrl, proxySignal);
            // 成功，告知代理池
            if (pool && proxyUrl) pool.release(proxyUrl, true);
            return;
        } catch (err) {
            // 外部主动中止不重试
            if (externalSignal?.aborted) throw err;
            // ★ 退化循环中止不重试 — 已有的内容是有效的，重试也会重蹈覆辙
            if (err instanceof Error && err.message === 'DEGENERATE_LOOP_ABORTED') return;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Cursor] 请求失败 (${attempt}/${maxRetries}): ${msg.substring(0, 100)}`);
            if (attempt < maxRetries) {

            // 提取 HTTP 状态码（如果有）
            const statusMatch = msg.match(/HTTP (\d+)/);
            const httpStatus = statusMatch ? parseInt(statusMatch[1]) : undefined;

            const proxyNetworkFail = isProxyNetworkError(err);
            const shouldRetry = shouldRetryWithProxy(err, httpStatus);

            // 只有代理网络层故障才标记代理失败（429/aborted 是上游问题，代理本身没问题）
            if (pool && proxyUrl) {
                pool.release(proxyUrl, proxyNetworkFail ? false : true);
            }

            console.error(`[Cursor] 请求失败 (${attempt}/${maxRetries})${proxyUrl ? ` [${proxyUrl}]` : ''} status=${httpStatus ?? 'N/A'}: ${msg}`);

            if (attempt < maxRetries && shouldRetry) {
                // 换代理重试，不等待
                const reason = httpStatus === 429 ? '上游限流(429)' :
                    msg.includes('aborted') ? '服务端断连' :
                    proxyNetworkFail ? '代理网络故障' : '上游错误';
                console.log(`[Cursor] ${reason}，切换代理重试...`);
                continue;
            } else if (attempt < maxRetries && !pool) {
                // 无代理池时原有逻辑：等 2s 重试
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
    externalSignal?: AbortSignal,
): Promise<void> {
    const headers = getChromeHeaders();

    // 详细日志记录在 handler 层

    proxyUrl: string | null = null,
    proxySignal: AbortSignal | null = null,
): Promise<void> {
    const headers = getChromeHeaders();

    console.log(`[Cursor] 发送请求: model=${req.model}, messages=${req.messages.length}${proxyUrl ? ` via ${proxyUrl}` : ' (直连)'}`);
    // 打印第一条消息内容前200字符，方便排查注入是否生效
    const firstMsg = req.messages[0];
    if (firstMsg) {
        const preview = typeof firstMsg.parts?.[0]?.text === 'string'
            ? firstMsg.parts[0].text.substring(0, 200)
            : JSON.stringify(firstMsg).substring(0, 200);
        console.log(`[Cursor] 首条消息预览(${firstMsg.role}): ${preview}`);
    }

    const config = getConfig();
    const controller = new AbortController();
    // 链接外部信号：外部中止时同步中止内部 controller
    if (externalSignal) {
        if (externalSignal.aborted) { controller.abort(); }
        else { externalSignal.addEventListener('abort', () => controller.abort(), { once: true }); }
    }

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

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), config.timeout * 1000);

    // 合并超时信号和代理失效信号
    const signals = [timeoutController.signal];
    if (proxySignal) signals.push(proxySignal);
    const signal = signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);

    // 构造 fetch 选项（有代理时用 undici，无代理用原生 fetch）
    let fetchFn: typeof fetch = fetch;
    let dispatcher: unknown = undefined;

    if (proxyUrl) {
        const { ProxyAgent, fetch: undiciFetch } = await import('undici');
        dispatcher = new ProxyAgent(proxyUrl);
        fetchFn = undiciFetch as unknown as typeof fetch;
    }

    // 流是否已开始输出（用于判断失败时是否可以重试）
    let streamStarted = false;

    try {
        const fetchOptions: RequestInit & { dispatcher?: unknown } = {
            method: 'POST',
            headers,
            body: JSON.stringify(req),
            signal: controller.signal,
            ...getProxyFetchOptions(),
        } as any);

            signal,
        };
        if (dispatcher) fetchOptions.dispatcher = dispatcher;

        const resp = await fetchFn(CURSOR_CHAT_API, fetchOptions as RequestInit);

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

        // ★ 退化重复检测器 (#66)
        // 模型有时会陷入循环，不断输出 </s>、</br> 等无意义标记
        // 检测原理：跟踪最近的连续相同 delta，超过阈值则中止流
        let lastDelta = '';
        let repeatCount = 0;
        const REPEAT_THRESHOLD = 8;       // 同一 delta 连续出现 8 次 → 退化
        let degenerateAborted = false;

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

                    // ★ 退化重复检测：当模型重复输出同一短文本片段时中止
                    if (event.type === 'text-delta' && event.delta) {
                        const trimmedDelta = event.delta.trim();
                        // 只检测短 token（长文本重复是正常的，比如重复的代码行）
                        if (trimmedDelta.length > 0 && trimmedDelta.length <= 20) {
                            if (trimmedDelta === lastDelta) {
                                repeatCount++;
                                if (repeatCount >= REPEAT_THRESHOLD) {
                                    console.warn(`[Cursor] ⚠️ 检测到退化循环: "${trimmedDelta}" 已连续重复 ${repeatCount} 次，中止流`);
                                    degenerateAborted = true;
                                    // 不再转发此 delta，直接中止
                                    reader.cancel();
                                    break;
                                }
                            } else {
                                lastDelta = trimmedDelta;
                                repeatCount = 1;
                            }
                        } else {
                            // 长文本或空白 → 重置计数
                            lastDelta = '';
                            repeatCount = 0;
                        }
                    }


                    streamStarted = true;
                    onChunk(event);
                } catch {
                    // 非 JSON 数据，忽略
                }
            }

            if (degenerateAborted) break;
        }

        // ★ 退化循环中止后，抛出特殊错误让外层 sendCursorRequest 不再重试
        if (degenerateAborted) {
            throw new Error('DEGENERATE_LOOP_ABORTED');
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
    } catch (err) {
        // 流已开始后的失败不允许换代理重试（下游已收到部分数据）
        if (streamStarted) {
            throw new Error(`[Cursor] 流传输中断（已输出部分数据，不重试）: ${err instanceof Error ? err.message : String(err)}`);
        }
        throw err;
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
    console.log(`[Cursor] API 原始响应 (${fullText.length} chars):\n${fullText}`);
    return fullText;
}

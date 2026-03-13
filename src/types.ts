// ==================== Anthropic API Types ====================

export interface AnthropicRequest {
    model: string;
    messages: AnthropicMessage[];
    max_tokens: number;
    stream?: boolean;
    system?: string | AnthropicContentBlock[];
    tools?: AnthropicTool[];
    temperature?: number;
    top_p?: number;
    stop_sequences?: string[];
}

export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
    type: 'text' | 'tool_use' | 'tool_result' | 'image';
    text?: string;
    // image fields
    source?: { type: string; media_type?: string; data: string };
    // tool_use fields
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    // tool_result fields
    tool_use_id?: string;
    content?: string | AnthropicContentBlock[];
    is_error?: boolean;
}

export interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

export interface AnthropicResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: string;
    stop_sequence: string | null;
    usage: { input_tokens: number; output_tokens: number };
}

// ==================== Cursor API Types ====================

export interface CursorChatRequest {
    context?: CursorContext[];
    model: string;
    id: string;
    messages: CursorMessage[];
    trigger: string;
}

export interface CursorContext {
    type: string;
    content: string;
    filePath: string;
}

export interface CursorMessage {
    parts: CursorPart[];
    id: string;
    role: string;
}

export interface CursorPart {
    type: string;
    text: string;
}

export interface CursorSSEEvent {
    type: string;
    delta?: string;
}

// ==================== Internal Types ====================

export interface ParsedToolCall {
    name: string;
    arguments: Record<string, unknown>;
}

export interface AppConfig {
    port: number;
    timeout: number;
    proxy?: string;
    cursorModel: string;
    vision?: {
        enabled: boolean;
        mode: 'ocr' | 'api';
        baseUrl: string;
        apiKey: string;
        model: string;
    };
    fingerprint: {
        userAgent: string;
    };
    proxyPool?: ProxyPoolConfig;
}

// ==================== Proxy Pool Types ====================

export type ProxyStatus = 'warming' | 'active' | 'checking' | 'cooling' | 'dead';

export interface ProxyEntry {
    url: string;
    name: string;
    status: ProxyStatus;
    validUntil: number;          // TTL到期时间戳，0表示需要检测
    failures: number;            // 连续失败次数
    cooldownUntil: number;       // 冷却到期时间戳
    cooldownCount: number;       // 已冷却次数（指数退避）
    lastCheckedAt: number;       // 最后一次健康检测时间
    isChecking: boolean;         // 防止并发重复检测
    invalidateController: AbortController; // 代理失效时通知正在使用的请求
}

export interface ProxyPoolConfig {
    enabled: boolean;
    proxies: Array<{ url: string; name: string }>;
    ttlSec: number;              // 代理有效期（秒），默认60
    perProxyTimeoutSec: number;  // 健康检测超时（秒），默认10
    maxFailures: number;         // 连续失败多少次进cooling，默认3
    cooldownBaseSec: number;     // 基础冷却时间（秒），默认120
    maxCooldownSec: number;      // 最长冷却时间（秒），默认1800
    maxProxyRetries: number;     // 单请求最多换几个代理，默认3
    fallbackDirect: boolean;     // 全池不可用时是否直连兜底
}

export interface AcquireResult {
    url: string | null;          // null表示直连兜底
    signal: AbortSignal | null;  // 代理失效信号，null表示直连
}

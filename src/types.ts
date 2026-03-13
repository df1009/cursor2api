// ==================== Anthropic API Types ====================

export interface AnthropicRequest {
    model: string;
    messages: AnthropicMessage[];
    max_tokens: number;
    stream?: boolean;
    system?: string | AnthropicContentBlock[];
    tools?: AnthropicTool[];
    tool_choice?: AnthropicToolChoice;
    temperature?: number;
    top_p?: number;
    stop_sequences?: string[];
    thinking?: { type: 'enabled' | 'disabled' | 'adaptive'; budget_tokens?: number };
}

/** tool_choice 控制模型是否必须调用工具
 *  - auto: 模型自行决定（默认）
 *  - any:  必须调用至少一个工具
 *  - tool: 必须调用指定工具
 */
export type AnthropicToolChoice =
    | { type: 'auto' }
    | { type: 'any' }
    | { type: 'tool'; name: string };

export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
    type: 'text' | 'tool_use' | 'tool_result' | 'image';
    text?: string;
    // image fields
    source?: { type: string; media_type?: string; data: string; url?: string };
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
    authTokens?: string[];  // API 鉴权 token 列表，为空则不鉴权
    maxAutoContinue: number;        // 自动续写最大次数，默认 3，设 0 禁用
    maxHistoryMessages: number;     // 历史消息条数硬限制，默认 100，-1 不限制
    vision?: {
        enabled: boolean;
        mode: 'ocr' | 'api';
        baseUrl: string;
        apiKey: string;
        model: string;
        proxy?: string;  // vision 独立代理（不影响 Cursor API 直连）
    };
    compression?: {
        enabled: boolean;          // 是否启用历史消息压缩
        level: 1 | 2 | 3;         // 压缩级别: 1=轻度, 2=中等(默认), 3=激进
        keepRecent: number;        // 保留最近 N 条消息不压缩
        earlyMsgMaxChars: number;  // 早期消息最大字符数
    };
    thinking?: {
        enabled: boolean;          // 是否启用 thinking（最高优先级，覆盖客户端请求）
    };
    logging?: {
        file_enabled: boolean;     // 是否启用日志文件持久化
        dir: string;               // 日志文件存储目录
        max_days: number;          // 日志保留天数
        persist_mode: 'compact' | 'full' | 'summary'; // 落盘模式: compact=精简, full=完整, summary=仅问答摘要
    };
    tools?: {
        schemaMode: 'compact' | 'full' | 'names_only';  // Schema 呈现模式
        descriptionMaxLength: number;                     // 描述截断长度 (0=不截断)
        includeOnly?: string[];                           // 白名单：只保留的工具名
        exclude?: string[];                               // 黑名单：要排除的工具名
        passthrough?: boolean;                            // 透传模式：跳过 few-shot 注入，直接嵌入工具定义
        disabled?: boolean;                               // 禁用模式：完全不注入工具定义，最大化节省上下文
    };
    sanitizeEnabled: boolean;    // 是否启用响应内容清洗（替换 Cursor 身份引用为 Claude），默认 false
    refusalPatterns?: string[];  // 自定义拒绝检测规则（追加到内置列表之后）
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

/**
 * proxy-pool.ts - 代理池管理
 *
 * 职责：
 * 1. 维护代理列表的健康状态（active/checking/cooling/dead）
 * 2. 每个代理有 TTL，过期后异步检测，不阻塞请求（乐观使用）
 * 3. 并发安全：acquire() 返回 URL 字符串，每个请求独立构造 ProxyAgent
 * 4. 代理失效时通过 AbortController 通知正在使用的请求
 * 5. 全池不可用时支持直连兜底或紧急复活
 */

import type { ProxyEntry, ProxyPoolConfig, AcquireResult } from './types.js';

const CHECK_URL = 'https://cursor.com/';

export class ProxyPool {
    private entries: ProxyEntry[] = [];
    private cursor: number = 0;
    private config: ProxyPoolConfig;

    constructor(config: ProxyPoolConfig) {
        this.config = config;
        this.entries = config.proxies.map(p => ({
            url: p.url,
            name: p.name,
            status: 'warming',
            validUntil: 0,
            failures: 0,
            cooldownUntil: 0,
            cooldownCount: 0,
            lastCheckedAt: 0,
            isChecking: false,
            invalidateController: new AbortController(),
        }));
    }

    // ==================== 公开接口 ====================

    /**
     * 启动预热：异步并发检测所有代理，不阻塞启动流程
     */
    warmup(): void {
        console.log(`[ProxyPool] 开始预热，共 ${this.entries.length} 个代理...`);
        Promise.all(this.entries.map(e => this.checkProxy(e))).then(() => {
            const active = this.entries.filter(e => e.status === 'active').length;
            console.log(`[ProxyPool] 预热完成: ${active}/${this.entries.length} 可用`);
        });
    }

    /**
     * 获取一个可用代理
     * 返回 { url, signal }，url=null 表示直连兜底
     */
    acquire(): AcquireResult {
        const available = this.entries.filter(e => e.status === 'active').map(e => e.name).join(' | ') || '无（直连）';
        console.log(`[ProxyPool] acquire() 调用，可用: ${available}`);
        // 先把冷却到期的代理复活
        this.reviveExpired();

        const total = this.entries.length;
        let checked = 0;

        while (checked < total) {
            const idx = this.cursor % total;
            this.cursor++;
            checked++;

            const entry = this.entries[idx];

            // 跳过 cooling / dead
            if (entry.status === 'cooling' || entry.status === 'dead') continue;

            const now = Date.now();

            // TTL 过期：异步检测，当前请求乐观继续用
            if (entry.validUntil > 0 && now > entry.validUntil && !entry.isChecking) {
                this.triggerAsyncCheck(entry);
            }

            console.log(`[ProxyPool] → 选中: ${entry.name} (${entry.url})`);
            return {
                url: entry.url,
                signal: entry.invalidateController.signal,
            };
        }

        // 所有代理不可用，尝试紧急复活
        const revived = this.emergencyRevive();
        if (revived) {
            return { url: revived.url, signal: revived.invalidateController.signal };
        }

        // 直连兜底
        if (this.config.fallbackDirect) {
            console.warn('[ProxyPool] 全部代理不可用，降级直连');
            return { url: null, signal: null };
        }

        throw new Error('[ProxyPool] 全部代理不可用且未配置直连兜底');
    }

    /**
     * 释放代理，报告成功或失败
     */
    release(url: string, success: boolean): void {
        const entry = this.entries.find(e => e.url === url);
        if (!entry) return;

        if (success) {
            entry.failures = 0;
            entry.cooldownCount = 0;
            entry.status = 'active';
            entry.validUntil = Date.now() + this.config.ttlSec * 1000;
        } else {
            entry.failures++;
            entry.validUntil = 0; // 强制下次重新检测

            if (entry.failures >= this.config.maxFailures) {
                entry.status = 'dead';
                console.warn(`[ProxyPool] ${entry.name} 连续失败 ${entry.failures} 次，标记 dead`);
                // 通知所有正在使用此代理的请求
                this.invalidateEntry(entry);
            } else {
                const cooldownMs = Math.min(
                    this.config.cooldownBaseSec * 1000 * Math.pow(2, entry.cooldownCount),
                    this.config.maxCooldownSec * 1000
                );
                entry.status = 'cooling';
                entry.cooldownUntil = Date.now() + cooldownMs;
                entry.cooldownCount++;
                console.warn(`[ProxyPool] ${entry.name} 失败 ${entry.failures} 次，冷却 ${Math.round(cooldownMs / 1000)}s`);
                // 通知正在使用此代理的请求
                this.invalidateEntry(entry);
            }
        }
    }

    /**
     * 获取池状态（用于 /proxy-status 接口）
     */
    status(): object {
        const now = Date.now();
        return {
            total: this.entries.length,
            active: this.entries.filter(e => e.status === 'active').length,
            warming: this.entries.filter(e => e.status === 'warming').length,
            checking: this.entries.filter(e => e.status === 'checking').length,
            cooling: this.entries.filter(e => e.status === 'cooling').length,
            dead: this.entries.filter(e => e.status === 'dead').length,
            proxies: this.entries.map(e => ({
                name: e.name,
                url: e.url,
                status: e.status,
                failures: e.failures,
                ttlRemainingMs: e.validUntil > 0 ? Math.max(0, e.validUntil - now) : 0,
                cooldownRemainingMs: e.cooldownUntil > 0 ? Math.max(0, e.cooldownUntil - now) : 0,
            })),
        };
    }

    // ==================== 内部方法 ====================

    /**
     * 把冷却到期的代理复活为 active（validUntil=0，下次用时触发检测）
     */
    private reviveExpired(): void {
        const now = Date.now();
        for (const entry of this.entries) {
            if (entry.status === 'cooling' && now >= entry.cooldownUntil) {
                entry.status = 'active';
                entry.validUntil = 0;
                console.log(`[ProxyPool] ${entry.name} 冷却结束，恢复 active`);
            }
        }
    }

    /**
     * 紧急复活：全部不可用时，找冷却剩余最短的代理强制复活
     */
    private emergencyRevive(): ProxyEntry | null {
        const cooling = this.entries
            .filter(e => e.status === 'cooling')
            .sort((a, b) => a.cooldownUntil - b.cooldownUntil);

        if (cooling.length === 0) return null;

        const soonest = cooling[0];
        const remaining = soonest.cooldownUntil - Date.now();

        // 冷却剩余 < 10s，直接紧急复活
        if (remaining < 10000) {
            soonest.status = 'active';
            soonest.validUntil = 0;
            console.warn(`[ProxyPool] 紧急复活 ${soonest.name}（冷却剩余 ${remaining}ms）`);
            return soonest;
        }

        return null;
    }

    /**
     * 异步触发健康检测（不阻塞调用方）
     */
    private triggerAsyncCheck(entry: ProxyEntry): void {
        if (entry.isChecking) return;
        entry.isChecking = true;
        entry.status = 'checking';

        this.checkProxy(entry).catch(() => {/* 错误已在 checkProxy 内处理 */});
    }

    /**
     * 对单个代理发起健康检测
     */
    private async checkProxy(entry: ProxyEntry): Promise<void> {
        entry.isChecking = true;
        const prevStatus = entry.status;
        if (prevStatus !== 'checking') entry.status = 'checking';

        const controller = new AbortController();
        const timeoutId = setTimeout(
            () => controller.abort(),
            this.config.perProxyTimeoutSec * 1000
        );

        try {
            // 动态 import undici，避免无代理池时的加载开销
            const { ProxyAgent, fetch: undiciFetch } = await import('undici');
            const agent = new ProxyAgent(entry.url);

            const resp = await (undiciFetch as typeof fetch)(CHECK_URL, {
                method: 'HEAD',
                // @ts-ignore undici dispatcher
                dispatcher: agent,
                signal: controller.signal,
                redirect: 'manual',
            });

            // 2xx/3xx 都算成功
            if (resp.status < 500) {
                entry.status = 'active';
                entry.validUntil = Date.now() + this.config.ttlSec * 1000;
                entry.lastCheckedAt = Date.now();
                entry.failures = 0;
                console.log(`[ProxyPool] ✅ ${entry.name} 检测通过 (${resp.status})`);
            } else {
                throw new Error(`HTTP ${resp.status}`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[ProxyPool] ❌ ${entry.name} 检测失败: ${msg}`);
            entry.lastCheckedAt = Date.now();
            // 预热阶段失败直接进 cooling
            this.release(entry.url, false);
        } finally {
            clearTimeout(timeoutId);
            entry.isChecking = false;
        }
    }

    /**
     * 失效代理：重置 invalidateController，通知正在使用的请求
     */
    private invalidateEntry(entry: ProxyEntry): void {
        entry.invalidateController.abort();
        // 重置，供下次使用
        entry.invalidateController = new AbortController();
    }
}

// ==================== 单例 ====================

let _pool: ProxyPool | null = null;

export function initProxyPool(config: ProxyPoolConfig): ProxyPool {
    _pool = new ProxyPool(config);
    _pool.warmup();
    return _pool;
}

export function getProxyPool(): ProxyPool | null {
    return _pool;
}

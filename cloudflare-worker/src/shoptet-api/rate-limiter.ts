import { GlobalStats } from './client';

export interface RateLimiterOptions {
    maxConcurrency?: number;
    maxRetries?: number;
    initialBackoffMs?: number;
    maxBackoffMs?: number;
}

export class ShoptetRateLimiter {
    private activeRequests = 0;
    private readonly maxConcurrency: number;
    private readonly maxRetries: number;
    private readonly initialBackoffMs: number;
    private readonly maxBackoffMs: number;
    private queue: (() => void)[] = [];

    // Těmto chybám pomůže retry (429, 500, 502, 503, 504)
    private readonly retryableStatuses = new Set([429, 500, 502, 503, 504]);

    constructor(options: RateLimiterOptions = {}) {
        this.maxConcurrency = options.maxConcurrency || 3;
        this.maxRetries = options.maxRetries || 15;
        this.initialBackoffMs = options.initialBackoffMs || 1000;
        this.maxBackoffMs = options.maxBackoffMs || 60000;
    }

    private async acquire(): Promise<void> {
        if (this.activeRequests < this.maxConcurrency) {
            this.activeRequests++;
            return;
        }

        return new Promise<void>((resolve) => {
            this.queue.push(resolve);
        });
    }

    private release(): void {
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            if (next) {
                next();
                return; // activeRequests zůstává stejný, slot se předal
            }
        }
        this.activeRequests--;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public async execute<T>(
        requestFn: () => Promise<Response>,
        parseFn: (res: Response) => Promise<T>
    ): Promise<T> {
        let attempt = 0;
        let lastError: Error | null = null;
        let totalWaitTime = 0;
        let receivedRetryAfter = false;

        while (attempt <= this.maxRetries) {
            await this.acquire();
            let response: Response;

            try {
                response = await requestFn();
            } catch (err) {
                this.release();
                // Network chyby zkusíme zopakovat
                lastError = err instanceof Error ? err : new Error(String(err));
                attempt++;
                await this.delay(this.calculateBackoff(attempt));
                continue;
            }

            // Pokud prošlo v pořádku (2xx)
            if (response.ok) {
                try {
                    const result = await parseFn(response);
                    this.release();
                    return result;
                } catch (parseErr) {
                    this.release();
                    throw new Error(`Chyba při parsování odpovědi: ${(parseErr as Error).message}`);
                }
            }

            // Zpracování chyb (4xx, 5xx)
            const status = response.status;
            this.release();

            if (this.retryableStatuses.has(status)) {
                attempt++;
                if (attempt > this.maxRetries) {
                    throw new Error(`API chyba ${status} po ${this.maxRetries} pokusech. Endpoint: ${response.url} | Celkový čas čekání: ${totalWaitTime}ms | Retry-After obdržen: ${receivedRetryAfter}`);
                }

                // Pokud máme hlavičku Retry-After (Shoptet ji posílá u 429)
                GlobalStats.retries[status] = (GlobalStats.retries[status] || 0) + 1;
                const retryAfterHeader = response.headers.get('Retry-After');
                let waitTime = this.calculateBackoff(attempt);

                if (retryAfterHeader) {
                    receivedRetryAfter = true;
                    const retryAfterSeconds = parseInt(retryAfterHeader, 10);
                    if (!isNaN(retryAfterSeconds)) {
                        waitTime = Math.max(waitTime, retryAfterSeconds * 1000);
                    }
                }

                totalWaitTime += waitTime;
                console.warn(`[RateLimiter] HTTP ${status}. Pokus ${attempt}/${this.maxRetries}. Čekám ${waitTime}ms. Celkem pročekáno: ${totalWaitTime}ms. Retry-After: ${retryAfterHeader || 'none'}`);
                await this.delay(waitTime);
                continue;
            } else {
                // Neopakovatelné chyby (400, 401, 403, 404, 409, 422 atd.)
                const errorBody = await response.text().catch(() => '');
                throw new Error(`FATA: API vrátil neopakovatelnou chybu HTTP ${status}. Tělo: ${errorBody}`);
            }
        }

        throw lastError || new Error('Neznámá chyba v RateLimiteru');
    }

    private calculateBackoff(attempt: number): number {
        const backoff = this.initialBackoffMs * Math.pow(2, attempt - 1);
        // Přidáme malý jitter +- 20%
        const jitter = backoff * 0.2 * (Math.random() * 2 - 1);
        return Math.min(this.maxBackoffMs, backoff + jitter);
    }
}

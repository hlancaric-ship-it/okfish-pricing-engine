import { GlobalStats } from './client';

export interface RateLimiterOptions {
    maxConcurrency?: number;
    maxRetries?: number;
    initialBackoffMs?: number;
    maxBackoffMs?: number;
}

export interface ExecuteOptions {
    // Statusy, které se i mimo 2xx mají předat parseFn (např. 404 = "smazáno",
    // volající to sám rozhodne), místo automatického throw. Bez tohoto volitelného
    // parametru se chování nemění -- výchozí je throw na cokoli mimo 2xx a mimo
    // retryableStatuses, přesně jako dřív.
    passThroughStatuses?: number[];
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
        parseFn: (res: Response) => Promise<T>,
        options: ExecuteOptions = {}
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

            // Pokud prošlo v pořádku (2xx), nebo je status explicitně vyžádán
            // volajícím jako "předej mi to i tak, rozhodnu si sám" (passThroughStatuses)
            if (response.ok || options.passThroughStatuses?.includes(response.status)) {
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
                    // BUG opraveno 2026-08-20: Shoptet posílá Retry-After jako HTTP-date
                    // (např. "Mon, 01 Jul 2024 12:01:11 GMT"), ne jako počet sekund --
                    // potvrzeno v https://developers.shoptet.com/api/documentation/rate-limiter/.
                    // parseInt() na datum vrátí NaN, takže se hlavička dřív potichu
                    // ignorovala a čekalo se jen na exponenciální backoff, ne na skutečný
                    // čas, kdy Shoptet znovu pustí požadavky. RFC 7231 povoluje Retry-After
                    // v obou tvarech (delay-seconds i HTTP-date), takže zkoušíme nejdřív
                    // čisté číslo (pro kompatibilitu, kdyby to Shoptet někdy změnil), pak
                    // datum.
                    const isPureDigits = /^\d+$/.test(retryAfterHeader.trim());
                    if (isPureDigits) {
                        const retryAfterSeconds = parseInt(retryAfterHeader, 10);
                        waitTime = Math.max(waitTime, retryAfterSeconds * 1000);
                    } else {
                        const retryAfterMs = Date.parse(retryAfterHeader);
                        if (!isNaN(retryAfterMs)) {
                            const delayMs = retryAfterMs - Date.now();
                            if (delayMs > 0) waitTime = Math.max(waitTime, delayMs);
                        }
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

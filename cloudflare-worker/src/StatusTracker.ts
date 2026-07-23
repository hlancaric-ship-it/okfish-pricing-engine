import { Env } from './feed-generator';

export class StatusTracker {
    public totalProducts: number;
    private env: Env;
    private startTime: number;
    private lastUpdate: number;

    constructor(env: Env, totalProducts: number) {
        this.env = env;
        this.totalProducts = totalProducts;
        this.startTime = Date.now();
        this.lastUpdate = Date.now();
    }

    async initialize() {
        await this.writeToKV(0, 'running');
    }

    async updateProgress(processed: number) {
        const now = Date.now();
        // Zabráníme příliš častému zápisu (Cloudflare KV limit je 1 zápis za sekundu, doporučujeme 3s)
        if (now - this.lastUpdate >= 3000) {
            this.lastUpdate = now;
            await this.writeToKV(processed, 'running');
        }
    }

    async forceUpdate(processed: number) {
        this.lastUpdate = Date.now();
        await this.writeToKV(processed, 'running');
    }

    async success(filename: string) {
        const duration = Math.round((Date.now() - this.startTime) / 1000);
        const data = {
            status: 'success',
            startedAt: new Date(this.startTime).toISOString(),
            durationSeconds: duration,
            totalProducts: this.totalProducts,
            feedVersion: filename
        };
        await this.env.VIP_KV.put('feed_generation_status', JSON.stringify(data));
    }

    async error(message: string) {
        const data = {
            status: 'failed',
            startedAt: new Date(this.startTime).toISOString(),
            error: message
        };
        await this.env.VIP_KV.put('feed_generation_status', JSON.stringify(data));
    }

    private async writeToKV(processed: number, status: string) {
        const now = Date.now();
        const elapsedSec = (now - this.startTime) / 1000;
        const speed = processed > 0 ? processed / elapsedSec : 0;
        const remaining = speed > 0 ? Math.round((this.totalProducts - processed) / speed) : null;
        
        const data = {
            status,
            startedAt: new Date(this.startTime).toISOString(),
            processedProducts: processed,
            totalProducts: this.totalProducts,
            progress: this.totalProducts > 0 ? Math.round((processed / this.totalProducts) * 1000) / 10 : 0,
            estimatedRemainingSeconds: remaining
        };
        
        await this.env.VIP_KV.put('feed_generation_status', JSON.stringify(data));
    }
}

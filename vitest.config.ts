import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        coverage: {
            include: ['src/**/*.ts', 'shared/**/*.ts', 'cloudflare-worker/src/**/*.ts']
        }
    }
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        coverage: {
            include: ['src/**/*.ts'],
            // bench/ and the loose root test-*.js scripts are one-off diagnostic
            // tools used during development (memory/backpressure investigation), not
            // part of the deployed Worker — everything under src/ is real application
            // code and is deliberately NOT excluded, low coverage there is reported
            // honestly rather than hidden.
            exclude: ['bench/**', 'dist/**']
        }
    }
});

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        // better-sqlite3 is a native addon; Vite must not try to pre-bundle it.
        server: {
            deps: {
                external: ["better-sqlite3"],
            },
        },
    },
});

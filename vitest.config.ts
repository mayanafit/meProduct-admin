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
        coverage: {
            provider: "v8",
            // `text` prints a table in the terminal; `html` writes a browsable
            // report to coverage/index.html with line-by-line highlighting.
            // The text reporter hides 100% files unless told otherwise, and it
            // only honours `skipFull` passed as its own option, not the
            // top-level one — without this the table omits every passing file.
            reporter: [["text", { skipFull: false }], ["html", {}]],
            reportsDirectory: "coverage",
            // Listing src explicitly means untested files show up as 0% rather
            // than being silently omitted from the report.
            include: ["src/**/*.ts"],
            exclude: [
                // Type-only; compiles to nothing.
                "src/types.ts",
                // Process entry points: composition and top-level side effects,
                // exercised by running the app, not by unit tests.
                "src/server.ts",
                "src/db/seed.ts",
            ],
        },
    },
});

import "dotenv/config";
import path from "node:path";

/**
 * The single place `process.env` is read. Importing this module loads `.env`
 * as a side effect, so it must be imported before anything that needs config.
 */

function requiredNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer, got "${raw}"`);
    }
    return parsed;
}

const DB_PATH_RAW = process.env["DB_PATH"] ?? "./data.sqlite";

/**
 * Signs the session cookie. Defaults so a fresh clone and the test suite run
 * without setup; a real deployment must set it, hence the warning.
 */
function sessionSecret(): string {
    const secret = process.env["SESSION_SECRET"];
    if (secret !== undefined && secret !== "") return secret;

    if (process.env["NODE_ENV"] === "production") {
        console.warn("SESSION_SECRET is not set — sessions are signed with a public default.");
    }
    return "meproduct-dev-session-secret";
}

function optionalString(name: string, fallback: string): string {
    const value = process.env[name];
    return value === undefined || value === "" ? fallback : value;
}

export const config = {
    PORT: requiredNumber("PORT", 3000),
    SESSION_SECRET: sessionSecret(),

    /**
     * The shop assistant talks to any OpenAI-compatible `/v1/chat/completions`
     * endpoint, so Ollama, LM Studio, llama.cpp and vLLM all work by changing
     * LLM_BASE_URL alone. Defaults point at a local Ollama.
     */
    LLM_BASE_URL: optionalString("LLM_BASE_URL", "http://localhost:11434").replace(/\/+$/, ""),
    /**
     * A 3B default on purpose: an 8B model on 8 GB RAM swaps and takes minutes
     * per turn, where this answers in under a second once warm. Measure any
     * substitute with `pnpm eval:model`.
     */
    LLM_MODEL: optionalString("LLM_MODEL", "llama3.2:3b"),
    /** Required by the OpenAI request shape; Ollama accepts and ignores it. */
    LLM_API_KEY: optionalString("LLM_API_KEY", "ollama"),
    /** Small models on modest hardware are not fast. */
    LLM_TIMEOUT_MS: requiredNumber("LLM_TIMEOUT_MS", 20000),
    /** Absolute, so the DB resolves the same regardless of cwd. */
    DB_PATH: path.resolve(process.cwd(), DB_PATH_RAW),
    NODE_ENV: process.env["NODE_ENV"] ?? "development",
} as const;

export type Config = typeof config;

import { Router } from "express";
import type { Request } from "express";
import type { Database as DB } from "better-sqlite3";
import type { Cart } from "../types.js";
import { AppError } from "../errors.js";
import { LlmUnavailableError } from "../services/llm.js";
import { emptyChatState, type Assistant, type ChatState } from "../services/assistant.js";
import { cartCount } from "../services/cart.js";
import { readString } from "./formValues.js";
import { config } from "../config/env.js";

/**
 * The shop assistant's HTTP surface. Thin on purpose: read session state, hand
 * it to the assistant, write the result back.
 */

/** Long enough for a real question, short enough not to be an attack surface. */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Inference is CPU/GPU-bound on the machine running the app, so a flood is a
 * denial-of-service against the operator's laptop rather than a billing risk.
 */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function getChat(req: Request): { state: ChatState; rate: { count: number; windowStart: number } } {
    const stored = req.session.chat;
    return {
        state: stored?.state ?? emptyChatState(),
        rate: stored?.rate ?? { count: 0, windowStart: Date.now() },
    };
}

/** Fixed window: simple, and precise enough for a local-only guard. */
function overRateLimit(rate: { count: number; windowStart: number }): boolean {
    const fresh = Date.now() - rate.windowStart > RATE_WINDOW_MS;
    if (fresh) {
        rate.count = 0;
        rate.windowStart = Date.now();
    }
    return rate.count >= RATE_LIMIT;
}

export function createChatRouter(db: DB, assistant: Assistant): Router {
    void db; // The assistant already holds the database it needs.
    const router = Router();

    /**
     * Polled by the widget when it opens, rather than checked during page
     * render — an unreachable endpoint must never slow the shop down.
     */
    router.get("/status", async (_req, res) => {
        res.json({ available: await assistant.isReachable() });
    });

    router.post("/", async (req, res) => {
        const message = readString(req.body, "message")?.trim() ?? "";

        if (message === "") {
            throw new AppError("Please type a message.", 400);
        }
        if (message.length > MAX_MESSAGE_LENGTH) {
            throw new AppError(`Please keep messages under ${MAX_MESSAGE_LENGTH} characters.`, 400);
        }

        const { state, rate } = getChat(req);

        if (overRateLimit(rate)) {
            res.status(429).json({
                reply: "You've sent a lot of messages — give it a minute.",
                cartCount: cartCount(req.session.cart ?? {}),
                modelAvailable: true,
            });
            return;
        }

        rate.count += 1;

        const cart: Cart = req.session.cart ?? {};

        try {
            const result = await assistant.respond(message, state, cart);

            req.session.chat = { state: result.state, rate };
            req.session.cart = result.cart;

            res.json({
                reply: result.reply,
                cartCount: cartCount(result.cart),
                modelAvailable: true,
                historyLength: result.state.modelHistory.length,
            });
        } catch (err) {
            if (!(err instanceof LlmUnavailableError)) throw err;

            // Save the counter even on failure so a broken endpoint can't be
            // hammered, but leave conversation state untouched.
            req.session.chat = { state, rate };

            res.status(503).json({
                reply: `I can't reach a language model at ${config.LLM_BASE_URL}. Start one with "ollama serve" and "ollama pull ${config.LLM_MODEL}", or point LLM_BASE_URL somewhere else.`,
                cartCount: cartCount(cart),
                modelAvailable: false,
            });
        }
    });

    return router;
}

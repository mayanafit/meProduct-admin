import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import type { Express } from "express";
import request from "supertest";
import { buildApp } from "../../src/app.js";
import type { Assistant, ChatState } from "../../src/services/assistant.js";
import { LlmUnavailableError } from "../../src/services/llm.js";
import type { Cart } from "../../src/types.js";
import { getProductBySku } from "../../src/repositories/product.js";
import { createTestDb, seedTestProducts } from "../helpers/testDb.js";

/**
 * A scripted assistant: no model, no database reasoning — just enough to prove
 * the route threads session state and cart correctly.
 */
function stubAssistant(
    handler: (message: string, state: ChatState, cart: Cart) => { reply: string; state?: ChatState; cart?: Cart },
    reachable = true
): Assistant {
    return {
        async respond(message, state, cart) {
            const result = handler(message, state, cart);
            return {
                reply: result.reply,
                state: result.state ?? state,
                cart: result.cart ?? cart,
            };
        },
        async isReachable() {
            return reachable;
        },
    };
}

/** Echoes back, and records the turn the way the real assistant would. */
function echoAssistant(): Assistant {
    return stubAssistant((message, state) => ({
        reply: `you said: ${message}`,
        state: {
            ...state,
            transcript: [...state.transcript, { role: "assistant", text: `you said: ${message}` }],
            modelHistory: [...state.modelHistory, `user: ${message}`, "assistant: unknown"],
        },
    }));
}

describe("POST /chat", () => {
    let db: DB;
    let mugId: number;

    beforeEach(() => {
        db = createTestDb();
        seedTestProducts(db);
        mugId = getProductBySku(db, "MUG-001")!.id;
    });

    afterEach(() => {
        db.close();
    });

    test("returns the assistant's reply", async () => {
        const res = await request(buildApp(db, { assistant: echoAssistant() }))
            .post("/chat")
            .send({ message: "hello" });

        expect(res.status).toBe(200);
        expect(res.body.reply).toBe("you said: hello");
        expect(res.body.modelAvailable).toBe(true);
    });

    test("rejects a blank message", async () => {
        const res = await request(buildApp(db, { assistant: echoAssistant() }))
            .post("/chat")
            .send({ message: "   " });

        expect(res.status).toBe(400);
    });

    test("rejects a missing message", async () => {
        const res = await request(buildApp(db, { assistant: echoAssistant() }))
            .post("/chat")
            .send({});

        expect(res.status).toBe(400);
    });

    test("rejects an absurdly long message", async () => {
        const res = await request(buildApp(db, { assistant: echoAssistant() }))
            .post("/chat")
            .send({ message: "x".repeat(5000) });

        expect(res.status).toBe(400);
    });

    test("carries conversation state across turns", async () => {
        const agent = request.agent(buildApp(db, { assistant: echoAssistant() }));

        await agent.post("/chat").send({ message: "one" });
        const res = await agent.post("/chat").send({ message: "two" });

        // The stub appends to modelHistory each turn; a second turn seeing the
        // first proves the session round-tripped.
        expect(res.body.reply).toBe("you said: two");
        expect(res.body.historyLength).toBeGreaterThan(2);
    });

    test("persists cart changes the assistant makes", async () => {
        const app = buildApp(db, {
            assistant: stubAssistant((_message, state, cart) => ({
                reply: "added",
                cart: { ...cart, [mugId]: 2 },
                state,
            })),
        });
        const agent = request.agent(app);

        const chat = await agent.post("/chat").send({ message: "add two mugs" });
        expect(chat.body.cartCount).toBe(2);

        // And the ordinary cart page sees the same session cart.
        const cartPage = await agent.get("/cart");
        expect(cartPage.text).toContain("Ceramic Mug");
    });

    test("reports an unreachable model without a 500", async () => {
        const app = buildApp(db, {
            assistant: {
                async respond() {
                    throw new LlmUnavailableError("connection refused");
                },
                async isReachable() {
                    return false;
                },
            },
        });

        const res = await request(app).post("/chat").send({ message: "hello" });

        expect(res.status).toBe(503);
        expect(res.body.modelAvailable).toBe(false);
        expect(res.body.reply).toMatch(/ollama|model/i);
    });

    test("lets an unexpected error surface as a 500", async () => {
        const app = buildApp(db, {
            assistant: {
                async respond() {
                    throw new Error("kaboom");
                },
                async isReachable() {
                    return true;
                },
            },
        });

        const res = await request(app).post("/chat").send({ message: "hello" });

        expect(res.status).toBe(500);
    });

    describe("rate limiting", () => {
        test("allows a normal burst then returns 429", async () => {
            const agent = request.agent(buildApp(db, { assistant: echoAssistant() }));

            let lastStatus = 200;
            for (let i = 0; i < 32; i++) {
                lastStatus = (await agent.post("/chat").send({ message: `m${i}` })).status;
            }

            expect(lastStatus).toBe(429);
        });

        test("is per visitor, not global", async () => {
            const app = buildApp(db, { assistant: echoAssistant() });
            const heavy = request.agent(app);

            for (let i = 0; i < 32; i++) await heavy.post("/chat").send({ message: `m${i}` });

            const fresh = request.agent(app);
            expect((await fresh.post("/chat").send({ message: "hi" })).status).toBe(200);
        });
    });
});

describe("GET /chat/status", () => {
    let db: DB;
    let app: Express;

    beforeEach(() => {
        db = createTestDb();
        app = buildApp(db, { assistant: echoAssistant() });
    });

    afterEach(() => {
        db.close();
    });

    test("reports availability without blocking page render", async () => {
        const res = await request(app).get("/chat/status");

        expect(res.status).toBe(200);
        expect(res.body.available).toBe(true);
    });

    test("reports unavailable rather than erroring", async () => {
        const offline = buildApp(db, {
            assistant: stubAssistant(() => ({ reply: "" }), false),
        });

        const res = await request(offline).get("/chat/status");

        expect(res.status).toBe(200);
        expect(res.body.available).toBe(false);
    });
});

describe("chat widget placement", () => {
    let db: DB;
    let app: Express;

    beforeEach(() => {
        db = createTestDb();
        seedTestProducts(db);
        app = buildApp(db, { assistant: echoAssistant() });
    });

    afterEach(() => {
        db.close();
    });

    test("appears on the shop", async () => {
        const res = await request(app).get("/");

        expect(res.text).toContain('data-testid="chat-widget"');
    });

    test("never appears on the admin", async () => {
        for (const path of ["/admin", "/admin/products", "/admin/orders"]) {
            const res = await request(app).get(path);
            expect(res.text, `widget leaked onto ${path}`).not.toContain('data-testid="chat-widget"');
        }
    });
});

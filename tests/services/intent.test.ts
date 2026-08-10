import { describe, test, expect } from "vitest";
import { parseIntent, extractIntent, INTENT_SCHEMA } from "../../src/services/intent.js";
import { LlmUnavailableError, type LlmClient } from "../../src/services/llm.js";

/** An LLM stub that returns canned strings, one per call, and records its input. */
function stubLlm(replies: string[]) {
    const calls: { messages: unknown; schema: unknown }[] = [];
    let next = 0;

    const client: LlmClient = {
        async complete(messages, jsonSchema) {
            calls.push({ messages, schema: jsonSchema });
            const reply = replies[next] ?? replies[replies.length - 1] ?? "";
            next += 1;
            return reply;
        },
        async isReachable() {
            return true;
        },
    };

    return { client, calls, callCount: () => next };
}

describe("parseIntent", () => {
    test("accepts a well-formed object", () => {
        expect(parseIntent('{"intent":"search","query":"mug","max_price":15}')).toEqual({
            intent: "search",
            query: "mug",
            max_price: 15,
        });
    });

    test("accepts an intent with no extra fields", () => {
        expect(parseIntent('{"intent":"view_cart"}')).toEqual({ intent: "view_cart" });
    });

    describe("tolerating how small models actually reply", () => {
        test("strips a markdown code fence", () => {
            expect(parseIntent('```json\n{"intent":"view_cart"}\n```')).toEqual({
                intent: "view_cart",
            });
        });

        test("strips a <think> block", () => {
            // Reasoning models (qwen3 and friends) emit this by default.
            expect(
                parseIntent('<think>The user wants their cart.</think>{"intent":"view_cart"}')
            ).toEqual({ intent: "view_cart" });
        });

        test("ignores prose around the object", () => {
            expect(parseIntent('Sure! Here you go: {"intent":"view_cart"} Hope that helps.')).toEqual(
                { intent: "view_cart" }
            );
        });

        test("handles a nested object without truncating early", () => {
            expect(parseIntent('{"intent":"search","query":"mug","meta":{"a":1}}')).toMatchObject({
                intent: "search",
                query: "mug",
            });
        });
    });

    describe("rejecting", () => {
        test.each([
            ["empty output", ""],
            ["prose with no JSON", "I think you want a mug."],
            ["malformed JSON", '{"intent":"search",'],
            ["a JSON array", '["search"]'],
            ["a JSON string", '"search"'],
            ["an unrecognised intent", '{"intent":"launch_missiles"}'],
            ["a missing intent field", '{"query":"mug"}'],
            ["a non-string intent", '{"intent":42}'],
        ])("returns undefined for %s", (_label, raw) => {
            expect(parseIntent(raw)).toBeUndefined();
        });
    });

    describe("sanitising fields", () => {
        test("drops a hallucinated product_id", () => {
            const parsed = parseIntent('{"intent":"add_to_cart","product_id":7,"product_ref":"mug"}');

            // Ids must come from our own search, never from the model.
            expect(parsed).toEqual({ intent: "add_to_cart", product_ref: "mug" });
            expect(parsed).not.toHaveProperty("product_id");
        });

        test("drops any other unrecognised field", () => {
            expect(parseIntent('{"intent":"view_cart","sql":"DROP TABLE products"}')).toEqual({
                intent: "view_cart",
            });
        });

        test.each([
            ["zero", 0],
            ["negative", -3],
            ["fractional", 1.5],
            ["absurd", 100000],
        ])("drops a %s quantity", (_label, quantity) => {
            const parsed = parseIntent(
                `{"intent":"add_to_cart","product_ref":"mug","quantity":${quantity}}`
            );

            expect(parsed).toEqual({ intent: "add_to_cart", product_ref: "mug" });
        });

        test("keeps a sensible quantity", () => {
            expect(
                parseIntent('{"intent":"add_to_cart","product_ref":"mug","quantity":3}')
            ).toMatchObject({ quantity: 3 });
        });

        test("drops a non-positive max_price", () => {
            expect(parseIntent('{"intent":"search","query":"mug","max_price":0}')).toEqual({
                intent: "search",
                query: "mug",
            });
        });

        test("trims strings and drops blank ones", () => {
            expect(parseIntent('{"intent":"search","query":"  mug  "}')).toEqual({
                intent: "search",
                query: "mug",
            });
            expect(parseIntent('{"intent":"search","query":"   "}')).toEqual({ intent: "search" });
        });

        test("keeps affirmative only when it is a real boolean", () => {
            expect(parseIntent('{"intent":"confirm","affirmative":true}')).toEqual({
                intent: "confirm",
                affirmative: true,
            });
            expect(parseIntent('{"intent":"confirm","affirmative":"yes"}')).toEqual({
                intent: "confirm",
            });
        });
    });
});

describe("extractIntent", () => {
    test("returns the parsed intent on a clean first reply", async () => {
        const { client, callCount } = stubLlm(['{"intent":"view_cart"}']);

        expect(await extractIntent(client, [], "what's in my basket?")).toEqual({
            intent: "view_cart",
        });
        expect(callCount()).toBe(1);
    });

    test("retries once when the first reply is unparseable", async () => {
        const { client, callCount } = stubLlm(["no idea mate", '{"intent":"view_cart"}']);

        expect(await extractIntent(client, [], "cart?")).toEqual({ intent: "view_cart" });
        expect(callCount()).toBe(2);
    });

    test("gives up as 'unknown' rather than guessing", async () => {
        const { client, callCount } = stubLlm(["nope", "still nope"]);

        expect(await extractIntent(client, [], "???")).toEqual({ intent: "unknown" });
        expect(callCount()).toBe(2);
    });

    test("passes the schema to the model as a hint", async () => {
        const { client, calls } = stubLlm(['{"intent":"view_cart"}']);
        await extractIntent(client, [], "cart?");

        expect(calls[0]?.schema).toBe(INTENT_SCHEMA);
    });

    test("sends the user's message last, after the system prompt", async () => {
        const { client, calls } = stubLlm(['{"intent":"confirm","affirmative":true}']);

        await extractIntent(client, ["user: add a mug", "assistant: asked_confirmation"], "yes");

        const messages = calls[0]?.messages as { role: string; content: string }[];
        expect(messages[0]?.role).toBe("system");
        expect(messages[messages.length - 1]).toEqual({ role: "user", content: "yes" });
    });

    test("replays our own turns as assistant messages, not as the user's", async () => {
        const { client, calls } = stubLlm(['{"intent":"confirm","affirmative":true}']);

        await extractIntent(client, ["user: add a mug", "assistant: asked_confirmation"], "yes");

        const messages = calls[0]?.messages as { role: string; content: string }[];

        // Sending our marker as a user turn makes the model read it as something
        // the shopper said, and it starts echoing that intent every turn.
        expect(messages[1]).toEqual({ role: "user", content: "add a mug" });
        expect(messages[2]?.role).toBe("assistant");
        expect(messages[2]?.content).toMatch(/confirm/i);
    });

    test("never leaks the raw marker vocabulary into the prompt", async () => {
        const { client, calls } = stubLlm(['{"intent":"view_cart"}']);

        await extractIntent(client, ["user: hi", "assistant: search"], "cart?");

        const messages = calls[0]?.messages as { role: string; content: string }[];
        expect(messages[2]?.content).not.toBe("search");
        expect(messages[2]?.content).toMatch(/listed some matching products/i);
    });

    test("lets an unavailable model surface rather than swallowing it", async () => {
        const client: LlmClient = {
            async complete() {
                throw new LlmUnavailableError("connection refused");
            },
            async isReachable() {
                return false;
            },
        };

        await expect(extractIntent(client, [], "hello")).rejects.toBeInstanceOf(
            LlmUnavailableError
        );
    });
});

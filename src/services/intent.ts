import type { LlmClient, LlmMessage } from "./llm.js";

/**
 * Turns a shopper's sentence into a small, validated object. This is the only
 * job the model does — everything downstream is deterministic code.
 *
 * Two invariants make this workable on a 3B-class model:
 *   1. The model never returns a product id, only the words the user used.
 *      Resolution happens against our own database.
 *   2. "unknown" is a valid answer. Anything that fails validation becomes
 *      unknown rather than a guess that could mutate state.
 */

export const INTENT_NAMES = [
    "search",
    "product_detail",
    "add_to_cart",
    "set_quantity",
    "view_cart",
    "lookup_order",
    "confirm",
    "smalltalk",
    "unknown",
] as const;

export type IntentName = (typeof INTENT_NAMES)[number];

export interface Intent {
    intent: IntentName;
    /** Free text to search the catalogue with. */
    query?: string;
    /** The product name or SKU as the user said it — never an id. */
    product_ref?: string;
    quantity?: number;
    max_price?: number;
    order_reference?: string;
    /** Only meaningful for `confirm`. */
    affirmative?: boolean;
}

/** Above this, a quantity is a typo or a joke rather than an order. */
const MAX_QUANTITY = 999;

/** Sent as a `response_format` hint. Runtimes vary in whether they enforce it. */
export const INTENT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["intent"],
    properties: {
        intent: { type: "string", enum: [...INTENT_NAMES] },
        query: { type: "string" },
        product_ref: { type: "string" },
        quantity: { type: "integer", minimum: 1, maximum: MAX_QUANTITY },
        max_price: { type: "number", minimum: 0 },
        order_reference: { type: "string" },
        affirmative: { type: "boolean" },
    },
} as const;

const SYSTEM_PROMPT = `You classify a shopper's message for an online store and reply with JSON only.

Reply with a single JSON object and nothing else. No prose, no code fences.

"intent" must be exactly one of:
- search            wants to find products ("do you sell mugs", "anything under 20")
- product_detail    wants details on one product ("how much is the tee", "tell me about it")
- add_to_cart       wants to add something ("add a mug", "I'll take two")
- set_quantity      wants to change or remove a cart line ("make that 3", "remove the tee")
- view_cart         wants to see the cart ("what's in my basket")
- lookup_order      wants an order's status, usually with a long reference code
- confirm           answering a yes/no question ("yes", "no", "go ahead")
- smalltalk         greeting or thanks
- unknown           anything else, including questions you cannot map above

Optional fields, include only when the message supplies them:
- query            (string) words to search products with
- product_ref      (string) the product name or code the user said, copied verbatim
- quantity         (integer, 1-${MAX_QUANTITY})
- max_price        (number) an upper price limit the user mentioned
- order_reference  (string) an order code
- affirmative      (boolean) for "confirm", true for yes and false for no

Rules that decide the close calls:
- A short yes/no answer is ALWAYS confirm, never smalltalk: "yes", "yeah", "sure",
  "go ahead", "ok", "please do" are confirm with affirmative true; "no", "nope",
  "no thanks", "leave it" are confirm with affirmative false.
- smalltalk is ONLY a greeting or thanks ("hi", "hello", "cheers", "thanks").
  Never use it for anything the shopper wants done.
- When the shopper refers to a product without naming it ("it", "that", "those",
  "make that 3"), still pick the action intent and simply omit product_ref.
  The app remembers which product is being discussed.

Never invent a product id. Never add fields that are not listed above.

Examples:
{"intent":"search","query":"mug","max_price":15}
{"intent":"add_to_cart","product_ref":"classic tee","quantity":2}
{"intent":"confirm","affirmative":true}
{"intent":"product_detail"}
{"intent":"set_quantity","quantity":3}
{"intent":"unknown"}`;

/**
 * Pulls the first balanced JSON object out of a model reply.
 *
 * Small models wrap output in code fences, prepend `<think>` blocks, and add
 * pleasantries. Brace counting (rather than a regex) is what makes a nested
 * object survive intact.
 */
function extractJsonObject(raw: string): string | undefined {
    const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");

    const start = withoutThinking.indexOf("{");
    if (start === -1) return undefined;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < withoutThinking.length; i++) {
        const char = withoutThinking[i];

        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;

        if (char === "{") depth += 1;
        if (char === "}") {
            depth -= 1;
            if (depth === 0) return withoutThinking.slice(start, i + 1);
        }
    }

    return undefined;
}

function cleanString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
}

function cleanQuantity(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
    return value >= 1 && value <= MAX_QUANTITY ? value : undefined;
}

function cleanPrice(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
    return value;
}

/**
 * Parses and validates a raw model reply. Returns `undefined` when the reply
 * can't be trusted, which the caller turns into a retry or `unknown`.
 *
 * Builds a fresh object field by field rather than editing the parsed one, so
 * anything the model invented — a `product_id`, a stray `sql` key — is dropped
 * by construction rather than by blocklist.
 */
export function parseIntent(raw: string): Intent | undefined {
    const json = extractJsonObject(raw);
    if (json === undefined) return undefined;

    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return undefined;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

    const record = parsed as Record<string, unknown>;
    const name = record["intent"];

    if (typeof name !== "string" || !(INTENT_NAMES as readonly string[]).includes(name)) {
        return undefined;
    }

    const intent: Intent = { intent: name as IntentName };

    const query = cleanString(record["query"]);
    if (query !== undefined) intent.query = query;

    const productRef = cleanString(record["product_ref"]);
    if (productRef !== undefined) intent.product_ref = productRef;

    const orderReference = cleanString(record["order_reference"]);
    if (orderReference !== undefined) intent.order_reference = orderReference;

    const quantity = cleanQuantity(record["quantity"]);
    if (quantity !== undefined) intent.quantity = quantity;

    const maxPrice = cleanPrice(record["max_price"]);
    if (maxPrice !== undefined) intent.max_price = maxPrice;

    if (typeof record["affirmative"] === "boolean") intent.affirmative = record["affirmative"];

    return intent;
}

/**
 * What each marker tells the model happened, in words rather than a bare label.
 *
 * Every phrase is fixed and describes only the *shape* of our last turn — never
 * a product name, price or description. That is what keeps catalogue text out
 * of the prompt while still giving the model enough context to read "yes" or
 * "how much is it?" correctly.
 */
const MARKER_PHRASES: Record<string, string> = {
    search: "(I listed some matching products.)",
    product_detail: "(I gave details on one product.)",
    asked_confirmation: "(I asked the shopper to confirm adding an item to the cart.)",
    confirmed: "(I added the item to the cart.)",
    cancelled: "(I cancelled the pending add.)",
    cart_changed: "(I updated a quantity in the cart.)",
    cart_shown: "(I showed the cart contents.)",
    order_shown: "(I showed an order's status.)",
    smalltalk: "(I said hello.)",
    unknown: "(I asked the shopper to rephrase.)",
};

/**
 * Turns stored marker lines into properly-roled chat messages.
 *
 * Sending our own turns as `role: "user"` — as an earlier version did — makes
 * the model read "assistant: search" as something the shopper said, which
 * primes it to answer `search` on every subsequent turn.
 */
function toMessages(modelHistory: string[]): LlmMessage[] {
    return modelHistory.map((line): LlmMessage => {
        if (line.startsWith("assistant: ")) {
            const marker = line.slice("assistant: ".length);
            return { role: "assistant", content: MARKER_PHRASES[marker] ?? `(${marker})` };
        }
        if (line.startsWith("user: ")) {
            return { role: "user", content: line.slice("user: ".length) };
        }
        return { role: "user", content: line };
    });
}

/**
 * One call, one retry, then `unknown`.
 *
 * `modelHistory` carries the user's own turns plus fixed markers for ours —
 * never catalogue text. See the security note in docs/phase-6-local-assistant.md.
 */
export async function extractIntent(
    llm: LlmClient,
    modelHistory: string[],
    message: string
): Promise<Intent> {
    const base: LlmMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...toMessages(modelHistory),
        { role: "user", content: message },
    ];

    const first = parseIntent(await llm.complete(base, INTENT_SCHEMA));
    if (first !== undefined) return first;

    const retry = parseIntent(
        await llm.complete(
            [
                ...base,
                {
                    role: "user",
                    content: "That was not valid JSON. Reply with only the JSON object.",
                },
            ],
            INTENT_SCHEMA
        )
    );

    return retry ?? { intent: "unknown" };
}

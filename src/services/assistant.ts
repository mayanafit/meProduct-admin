import type { Database as DB } from "better-sqlite3";
import type { Cart, Product } from "../types.js";
import type { Intent } from "./intent.js";
import { extractIntent } from "./intent.js";
import type { LlmClient } from "./llm.js";
import { searchProducts, getProductById } from "../repositories/product.js";
import { getOrderByReference, getOrderWithItems } from "../repositories/order.js";
import { addToCart, setCartQuantity, resolveCart } from "./cart.js";

/**
 * The deterministic half of the shop assistant. The model produces an `Intent`
 * and nothing else; everything here is ordinary code over services that are
 * already tested elsewhere.
 *
 * Two properties this file is responsible for keeping:
 *   - The cart is only ever written by an explicit `confirm` turn.
 *   - `modelHistory` never contains catalogue text, so product descriptions
 *     can't be replayed into a prompt. See docs/phase-6-local-assistant.md.
 */

export interface PendingAdd {
    productId: number;
    quantity: number;
}

export interface ChatState {
    /** Shown in the browser. May quote product data. Never sent to the model. */
    transcript: { role: "user" | "assistant"; text: string }[];
    /** Sent to the model. User turns verbatim; our turns as fixed markers only. */
    modelHistory: string[];
    /** Lets "make that 2" work without putting product text in the prompt. */
    lastProductId?: number;
    /** Set by add_to_cart, consumed by the next turn, discarded otherwise. */
    pending?: PendingAdd;
}

export interface RouteResult {
    reply: string;
    state: ChatState;
    cart: Cart;
}

export interface Assistant {
    respond(message: string, state: ChatState, cart: Cart): Promise<RouteResult>;
    isReachable(): Promise<boolean>;
}

/** Fixed strings — the whole point is that they carry no catalogue text. */
type Marker =
    | "search"
    | "product_detail"
    | "asked_confirmation"
    | "confirmed"
    | "cancelled"
    | "cart_changed"
    | "cart_shown"
    | "order_shown"
    | "smalltalk"
    | "unknown";

export function emptyChatState(): ChatState {
    return { transcript: [], modelHistory: [] };
}

const MAX_TRANSCRIPT = 40;
const MAX_MODEL_HISTORY = 12;

function money(value: number): string {
    return value.toFixed(2);
}

function describe(product: Product): string {
    const stock = product.stock_quantity === 0 ? "out of stock" : `${product.stock_quantity} in stock`;
    return `${product.name} · ${money(product.price)} · ${stock}`;
}

/** How a product reference in an intent becomes a real row. */
type Resolution =
    | { kind: "found"; product: Product }
    | { kind: "ambiguous"; matches: Product[] }
    | { kind: "missing" }
    | { kind: "unspecified" };

/**
 * Resolves against our own data — the model never supplies an id.
 * With no reference, falls back to whatever the conversation last touched.
 */
function resolveProduct(db: DB, intent: Intent, state: ChatState): Resolution {
    if (intent.product_ref !== undefined) {
        const matches = searchProducts(db, intent.product_ref);

        if (matches.length === 0) return { kind: "missing" };
        if (matches.length === 1) return { kind: "found", product: matches[0]! };

        // An exact name or sku hit wins over a loose substring match.
        const needle = intent.product_ref.toLowerCase();
        const exact = matches.find(
            (p) => p.name.toLowerCase() === needle || p.sku?.toLowerCase() === needle
        );

        return exact === undefined
            ? { kind: "ambiguous", matches }
            : { kind: "found", product: exact };
    }

    if (state.lastProductId !== undefined) {
        const product = getProductById(db, state.lastProductId);
        if (product !== undefined && product.archived_at === null) {
            return { kind: "found", product };
        }
    }

    return { kind: "unspecified" };
}

function ambiguityReply(matches: Product[]): string {
    const names = matches.slice(0, 5).map((p) => p.name).join(", ");
    return `I found several: ${names}. Which one did you mean?`;
}

/**
 * Routes one intent. Pure with respect to the model — no network, no async —
 * which is what makes the assistant's behaviour fully testable offline.
 */
export function routeIntent(db: DB, intent: Intent, state: ChatState, cart: Cart): RouteResult {
    // A staged add survives exactly one turn: only `confirm` may consume it.
    // Anything else discards it, so a "yes" three messages later does nothing.
    // Destructured out rather than set to undefined — `exactOptionalPropertyTypes`
    // distinguishes "absent" from "present and undefined".
    const { pending: staged, ...withoutPending } = state;
    const pending = intent.intent === "confirm" ? staged : undefined;
    let next: ChatState = withoutPending;
    let nextCart = cart;

    function finish(reply: string, marker: Marker, patch: Partial<ChatState> = {}): RouteResult {
        next = { ...next, ...patch };

        const turn: ChatState["transcript"][number] = { role: "assistant", text: reply };

        return {
            reply,
            cart: nextCart,
            state: {
                ...next,
                transcript: [...next.transcript, turn].slice(-MAX_TRANSCRIPT),
                modelHistory: [...next.modelHistory, `assistant: ${marker}`].slice(
                    -MAX_MODEL_HISTORY
                ),
            },
        };
    }

    switch (intent.intent) {
        case "search": {
            const all = searchProducts(db, intent.query ?? "");
            const matches =
                intent.max_price === undefined
                    ? all
                    : all.filter((p) => p.price <= intent.max_price!);

            if (matches.length === 0) {
                const limit =
                    intent.max_price === undefined ? "" : ` under ${money(intent.max_price)}`;
                return finish(`I couldn't find anything matching that${limit}.`, "search");
            }

            const lines = matches.map((p) => `• ${describe(p)}`).join("\n");
            const header = matches.length === 1 ? "1 match:" : `${matches.length} matches:`;

            return finish(`${header}\n${lines}`, "search", { lastProductId: matches[0]!.id });
        }

        case "product_detail": {
            const found = resolveProduct(db, intent, state);

            if (found.kind === "missing") return finish("I couldn't find that product.", "product_detail");
            if (found.kind === "unspecified") return finish("Which product do you mean?", "product_detail");
            if (found.kind === "ambiguous") return finish(ambiguityReply(found.matches), "product_detail");

            const { product } = found;
            const detail = product.description === null ? "" : `\n${product.description}`;

            return finish(`${describe(product)}${detail}`, "product_detail", {
                lastProductId: product.id,
            });
        }

        case "add_to_cart": {
            const found = resolveProduct(db, intent, state);

            if (found.kind === "missing") return finish("I couldn't find that product.", "unknown");
            if (found.kind === "unspecified") return finish("Which product would you like?", "unknown");
            if (found.kind === "ambiguous") return finish(ambiguityReply(found.matches), "unknown");

            const { product } = found;

            if (product.stock_quantity === 0) {
                return finish(`Sorry — ${product.name} is out of stock.`, "unknown", {
                    lastProductId: product.id,
                });
            }

            const asked = intent.quantity ?? 1;
            const quantity = Math.min(asked, product.stock_quantity);
            const clamped =
                quantity < asked ? ` (only ${product.stock_quantity} in stock)` : "";
            const total = money(product.price * quantity);

            return finish(
                `Add ${quantity} × ${product.name} — ${total}${clamped}? Reply yes or no.`,
                "asked_confirmation",
                { lastProductId: product.id, pending: { productId: product.id, quantity } }
            );
        }

        case "confirm": {
            if (pending === undefined) {
                return finish("There's nothing waiting to confirm.", "unknown");
            }
            if (intent.affirmative !== true) {
                return finish("No problem — I've left that out of your cart.", "cancelled");
            }

            // Re-check stock: it may have moved between the ask and the yes.
            const product = getProductById(db, pending.productId);
            if (product === undefined || product.archived_at !== null) {
                return finish("Sorry — that product is no longer available.", "unknown");
            }
            if (product.stock_quantity < pending.quantity) {
                return finish(
                    product.stock_quantity === 0
                        ? `Sorry — ${product.name} just went out of stock.`
                        : `Sorry — only ${product.stock_quantity} of ${product.name} left now.`,
                    "unknown"
                );
            }

            nextCart = addToCart(cart, pending.productId, pending.quantity);
            const summary = resolveCart(db, nextCart);

            return finish(
                `Added ${pending.quantity} × ${product.name}. Your cart: ${summary.itemCount} item(s), ${money(summary.total)}.`,
                "confirmed"
            );
        }

        case "set_quantity": {
            const found = resolveProduct(db, intent, state);

            if (found.kind === "missing") return finish("I couldn't find that product.", "unknown");
            if (found.kind === "unspecified") return finish("Which product do you mean?", "unknown");
            if (found.kind === "ambiguous") return finish(ambiguityReply(found.matches), "unknown");

            const { product } = found;
            // A set_quantity with no number reads as "take it out".
            const asked = intent.quantity ?? 0;
            const quantity = Math.min(asked, product.stock_quantity);

            nextCart = setCartQuantity(cart, product.id, quantity);
            const summary = resolveCart(db, nextCart);

            const reply =
                quantity === 0
                    ? `Removed ${product.name}. Your cart: ${summary.itemCount} item(s), ${money(summary.total)}.`
                    : `${product.name} is now ${quantity} in your cart — ${money(summary.total)} total.`;

            return finish(reply, "cart_changed", { lastProductId: product.id });
        }

        case "view_cart": {
            const summary = resolveCart(db, cart);

            if (summary.items.length === 0) return finish("Your cart is empty.", "cart_shown");

            const lines = summary.items
                .map((item) => `• ${item.quantity} × ${item.product.name} — ${money(item.lineTotal)}`)
                .join("\n");
            const warnings = summary.issues.map((issue) => `\n⚠ ${issue.message}`).join("");

            return finish(`${lines}\nTotal: ${money(summary.total)}${warnings}`, "cart_shown");
        }

        case "lookup_order": {
            if (intent.order_reference === undefined) {
                return finish(
                    "What's your order reference? It's the long code on your confirmation page.",
                    "order_shown"
                );
            }

            const summary = getOrderByReference(db, intent.order_reference);
            const order = summary === undefined ? undefined : getOrderWithItems(db, summary.id);

            if (order === undefined) {
                return finish("I couldn't find an order with that reference.", "order_shown");
            }

            const lines = order.items
                .map((item) => `• ${item.quantity} × ${item.product_name} — ${money(item.quantity * item.unit_price)}`)
                .join("\n");

            return finish(
                `Order ${order.reference}\nStatus: ${order.status}\n${lines}\nTotal: ${money(order.total)}`,
                "order_shown"
            );
        }

        case "smalltalk":
            return finish(
                "Hello! I can search the shop, tell you about a product, or add things to your cart.",
                "smalltalk"
            );

        case "unknown":
        default:
            return finish(
                "I didn't catch that. Try something like \"do you have any mugs?\" or \"add a tee to my cart\".",
                "unknown"
            );
    }
}

/** Wires the model to the router. The only async part of the assistant. */
export function createAssistant(db: DB, llm: LlmClient): Assistant {
    return {
        async respond(message, state, cart) {
            const intent = await extractIntent(llm, state.modelHistory, message);

            // Record the shopper's own words on both histories before routing:
            // the model needs them, and they contain no catalogue text.
            const turn: ChatState["transcript"][number] = { role: "user", text: message };
            const withUserTurn: ChatState = {
                ...state,
                transcript: [...state.transcript, turn].slice(-MAX_TRANSCRIPT),
                modelHistory: [...state.modelHistory, `user: ${message}`].slice(
                    -MAX_MODEL_HISTORY
                ),
            };

            return routeIntent(db, intent, withUserTurn, cart);
        },

        isReachable() {
            return llm.isReachable();
        },
    };
}

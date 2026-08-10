import type { Cart } from "./types.js";
import type { ChatState } from "./services/assistant.js";

/**
 * Teaches express-session about what we keep per visitor.
 *
 * `cart` holds product ids and quantities only — see `services/cart.ts`.
 * `chat.state.modelHistory` is the only part of `chat` ever sent to a model,
 * and it deliberately carries no catalogue text.
 */
declare module "express-session" {
    interface SessionData {
        cart?: Cart;
        chat?: {
            state: ChatState;
            /** Fixed-window counter behind the per-visitor message cap. */
            rate?: { count: number; windowStart: number };
        };
    }
}

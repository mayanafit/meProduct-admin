import type { Cart } from "./types.js";

/**
 * Teaches express-session about the cart so routes never reach for `any`.
 * The session holds product ids and quantities only — see `services/cart.ts`.
 */
declare module "express-session" {
    interface SessionData {
        cart?: Cart;
    }
}

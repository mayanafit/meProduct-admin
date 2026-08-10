import type { Database as DB } from "better-sqlite3";
import type { Cart, CartIssue, CartItem, NewOrderLine, ResolvedCart } from "../types.js";
import { getProductById } from "../repositories/product.js";

/**
 * The cart holds product ids and quantities and nothing else — no names, no
 * prices. Everything else is resolved from the database on each render, so a
 * catalogue change is reflected immediately and `placeOrder` stays the only
 * place a price is ever snapshotted.
 *
 * The mutation helpers are pure: they return a new cart rather than editing the
 * session object in place, which keeps them trivial to test.
 */

function isValidQuantity(quantity: number): boolean {
    return Number.isInteger(quantity) && quantity > 0;
}

/** Adds to whatever quantity is already there. Ignores nonsense quantities. */
export function addToCart(cart: Cart, productId: number, quantity: number): Cart {
    if (!isValidQuantity(quantity)) return { ...cart };

    return { ...cart, [productId]: (cart[productId] ?? 0) + quantity };
}

/** Replaces the quantity outright. Zero or less removes the line. */
export function setCartQuantity(cart: Cart, productId: number, quantity: number): Cart {
    const next = { ...cart };

    if (!isValidQuantity(quantity)) {
        delete next[productId];
        return next;
    }

    next[productId] = quantity;
    return next;
}

export function clearCart(): Cart {
    return {};
}

/** Total units, not number of distinct products — this is the nav badge figure. */
export function cartCount(cart: Cart): number {
    return Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
}

/** The shape `placeOrder` takes. */
export function cartLines(cart: Cart): NewOrderLine[] {
    return Object.entries(cart).map(([productId, quantity]) => ({
        productId: Number(productId),
        quantity,
    }));
}

/**
 * Joins the cart against current catalogue data.
 *
 * `issues` are the things that would make checkout fail, surfaced here so the
 * cart page can warn first. Carts reserve no stock, so an item can go out of
 * stock between adding and checking out — that's expected, not a bug.
 */
export function resolveCart(db: DB, cart: Cart): ResolvedCart {
    const items: CartItem[] = [];
    const issues: CartIssue[] = [];

    for (const [rawId, quantity] of Object.entries(cart)) {
        const productId = Number(rawId);
        const product = getProductById(db, productId);

        if (product === undefined) {
            issues.push({
                productId,
                productName: `Product ${productId}`,
                message: "This product is no longer available and has been removed.",
            });
            continue;
        }

        items.push({ product, quantity, lineTotal: product.price * quantity });

        if (product.archived_at !== null) {
            issues.push({
                productId,
                productName: product.name,
                message: `"${product.name}" is no longer available.`,
            });
        } else if (product.stock_quantity === 0) {
            issues.push({
                productId,
                productName: product.name,
                message: `"${product.name}" is out of stock.`,
            });
        } else if (product.stock_quantity < quantity) {
            issues.push({
                productId,
                productName: product.name,
                message: `Only ${product.stock_quantity} of "${product.name}" left — please reduce the quantity.`,
            });
        }
    }

    return {
        items,
        total: items.reduce((sum, item) => sum + item.lineTotal, 0),
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        issues,
    };
}

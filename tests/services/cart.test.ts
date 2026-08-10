import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import {
    addToCart,
    setCartQuantity,
    clearCart,
    cartLines,
    cartCount,
    resolveCart,
} from "../../src/services/cart.js";
import type { Cart } from "../../src/types.js";
import { archiveProduct, adjustStock } from "../../src/repositories/product.js";
import { createTestDb, seedTestProducts } from "../helpers/testDb.js";

describe("cart (pure operations)", () => {
    describe("addToCart", () => {
        test("adds a product", () => {
            expect(addToCart({}, 1, 2)).toEqual({ 1: 2 });
        });

        test("accumulates when the product is already in the cart", () => {
            expect(addToCart({ 1: 2 }, 1, 3)).toEqual({ 1: 5 });
        });

        test("leaves other products alone", () => {
            expect(addToCart({ 1: 2 }, 7, 1)).toEqual({ 1: 2, 7: 1 });
        });

        test("does not mutate the cart it was given", () => {
            const cart: Cart = { 1: 2 };
            addToCart(cart, 1, 3);

            expect(cart).toEqual({ 1: 2 });
        });

        test("ignores a non-positive quantity", () => {
            expect(addToCart({}, 1, 0)).toEqual({});
            expect(addToCart({}, 1, -5)).toEqual({});
        });

        test("ignores a fractional quantity", () => {
            expect(addToCart({}, 1, 1.5)).toEqual({});
        });
    });

    describe("setCartQuantity", () => {
        test("replaces rather than accumulates", () => {
            expect(setCartQuantity({ 1: 2 }, 1, 5)).toEqual({ 1: 5 });
        });

        test("removes the line when set to zero", () => {
            expect(setCartQuantity({ 1: 2, 2: 1 }, 1, 0)).toEqual({ 2: 1 });
        });

        test("removes the line when set negative", () => {
            expect(setCartQuantity({ 1: 2 }, 1, -1)).toEqual({});
        });
    });

    describe("clearCart / cartCount / cartLines", () => {
        test("clearCart empties everything", () => {
            expect(clearCart()).toEqual({});
        });

        test("cartCount totals the quantities, not the line count", () => {
            expect(cartCount({ 1: 2, 2: 3 })).toBe(5);
            expect(cartCount({})).toBe(0);
        });

        test("cartLines produces what placeOrder expects", () => {
            expect(cartLines({ 1: 2, 7: 1 })).toEqual([
                { productId: 1, quantity: 2 },
                { productId: 7, quantity: 1 },
            ]);
        });

        test("cartLines on an empty cart is an empty list", () => {
            expect(cartLines({})).toEqual([]);
        });
    });
});

describe("resolveCart", () => {
    let db: DB;
    /** Classic Tee, 50 @ 19.99 */
    let teeId: number;
    /** Ceramic Mug, 10 @ 9.99 */
    let mugId: number;

    beforeEach(() => {
        db = createTestDb();
        const ids = seedTestProducts(db);
        teeId = ids[0]!;
        mugId = ids[1]!;
    });

    afterEach(() => {
        db.close();
    });

    test("resolves names and prices from the database, not the cart", () => {
        const resolved = resolveCart(db, { [teeId]: 2 });

        expect(resolved.items).toHaveLength(1);
        expect(resolved.items[0]).toMatchObject({ quantity: 2 });
        expect(resolved.items[0]?.product.name).toBe("Classic Tee");
    });

    test("computes line totals and an order total", () => {
        const resolved = resolveCart(db, { [teeId]: 2, [mugId]: 3 });

        expect(resolved.total).toBeCloseTo(2 * 19.99 + 3 * 9.99, 5);
        expect(resolved.itemCount).toBe(5);
    });

    test("picks up a price change made after the item went in the cart", () => {
        const cart: Cart = { [teeId]: 1 };
        db.prepare("UPDATE products SET price = 30 WHERE id = ?").run(teeId);

        // Nothing is cached in the cart, so the new price shows immediately.
        expect(resolveCart(db, cart).total).toBeCloseTo(30, 5);
    });

    test("an empty cart resolves to zeros", () => {
        expect(resolveCart(db, {})).toMatchObject({ items: [], total: 0, itemCount: 0, issues: [] });
    });

    test("raises no issues for a healthy cart", () => {
        expect(resolveCart(db, { [teeId]: 2 }).issues).toEqual([]);
    });

    test("flags a quantity above available stock", () => {
        const resolved = resolveCart(db, { [mugId]: 11 });

        expect(resolved.issues).toHaveLength(1);
        expect(resolved.issues[0]?.message).toMatch(/only 10/i);
        expect(resolved.issues[0]?.productName).toBe("Ceramic Mug");
    });

    test("allows exactly the available stock", () => {
        expect(resolveCart(db, { [mugId]: 10 }).issues).toEqual([]);
    });

    test("flags a product archived after it went in the cart", () => {
        archiveProduct(db, teeId);

        const resolved = resolveCart(db, { [teeId]: 1 });

        expect(resolved.issues[0]?.message).toMatch(/no longer available/i);
    });

    test("flags a product that has since sold out", () => {
        adjustStock(db, mugId, -10);

        expect(resolveCart(db, { [mugId]: 1 }).issues[0]?.message).toMatch(/out of stock/i);
    });

    test("drops a product that has been deleted outright", () => {
        const resolved = resolveCart(db, { 9999: 1 });

        expect(resolved.items).toHaveLength(0);
        expect(resolved.issues).toHaveLength(1);
    });

    test("still totals the healthy lines when another line has an issue", () => {
        const resolved = resolveCart(db, { [teeId]: 1, [mugId]: 99 });

        expect(resolved.items).toHaveLength(2);
        expect(resolved.issues).toHaveLength(1);
        expect(resolved.total).toBeCloseTo(19.99 + 99 * 9.99, 5);
    });
});

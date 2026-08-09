import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { recordMovement, listMovementsForProduct } from "../../src/repositories/stockMovement.js";
import { insertProduct } from "../../src/repositories/product.js";
import { createTestDb } from "../helpers/testDb.js";

const TEE = {
    name: "Classic Tee",
    sku: "TEE-001",
    price: 19.99,
    description: null,
    stock_quantity: 50,
};

describe("stock movement repository", () => {
    let db: DB;
    let productId: number;

    beforeEach(() => {
        db = createTestDb();
        productId = insertProduct(db, TEE);
    });

    afterEach(() => {
        db.close();
    });

    test("records a movement and reads it back", () => {
        recordMovement(db, { productId, quantityChange: 50, reason: "initial_stock" });

        const movements = listMovementsForProduct(db, productId);

        expect(movements).toHaveLength(1);
        expect(movements[0]).toMatchObject({
            product_id: productId,
            quantity_change: 50,
            reason: "initial_stock",
            reference_id: null,
        });
    });

    test("stores the originating order as reference_id", () => {
        recordMovement(db, {
            productId,
            quantityChange: -2,
            reason: "order",
            referenceId: 42,
        });

        expect(listMovementsForProduct(db, productId)[0]).toMatchObject({
            quantity_change: -2,
            reason: "order",
            reference_id: 42,
        });
    });

    test("returns the newest movement first", () => {
        recordMovement(db, { productId, quantityChange: 50, reason: "initial_stock" });
        recordMovement(db, { productId, quantityChange: -2, reason: "order", referenceId: 1 });
        recordMovement(db, { productId, quantityChange: 2, reason: "order_cancelled", referenceId: 1 });

        // created_at has second resolution, so ties are broken by id.
        expect(listMovementsForProduct(db, productId).map((m) => m.reason)).toEqual([
            "order_cancelled",
            "order",
            "initial_stock",
        ]);
    });

    test("only returns movements for the product asked for", () => {
        const otherId = insertProduct(db, { ...TEE, sku: "MUG-001", name: "Mug" });
        recordMovement(db, { productId, quantityChange: 50, reason: "initial_stock" });
        recordMovement(db, { productId: otherId, quantityChange: 10, reason: "initial_stock" });

        expect(listMovementsForProduct(db, productId)).toHaveLength(1);
    });

    test("returns an empty array for a product with no history", () => {
        expect(listMovementsForProduct(db, productId)).toEqual([]);
    });

    test("refuses a movement against a product that does not exist", () => {
        expect(() =>
            recordMovement(db, { productId: 999, quantityChange: 1, reason: "adjustment" })
        ).toThrow(/FOREIGN KEY/i);
    });
});

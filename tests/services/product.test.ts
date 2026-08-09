import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import {
    createProduct,
    updateProductDetails,
    archiveProductById,
    adjustStockWithReason,
    getProductOrThrow,
} from "../../src/services/product.js";
import { listProducts } from "../../src/repositories/product.js";
import { listMovementsForProduct } from "../../src/repositories/stockMovement.js";
import { AppError } from "../../src/errors.js";
import { createTestDb } from "../helpers/testDb.js";

const VALID = {
    name: "Classic Tee",
    sku: "TEE-001",
    price: 19.99,
    description: "Cotton tee.",
    stock_quantity: 50,
};

function countRows(db: DB, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

describe("product service", () => {
    let db: DB;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        db.close();
    });

    describe("createProduct", () => {
        test("creates the product and its opening stock movement together", () => {
            const product = createProduct(db, VALID);

            expect(product).toMatchObject({ name: "Classic Tee", stock_quantity: 50 });

            const movements = listMovementsForProduct(db, product.id);
            expect(movements).toHaveLength(1);
            expect(movements[0]).toMatchObject({
                quantity_change: 50,
                reason: "initial_stock",
            });
        });

        test("trims whitespace from name and sku", () => {
            const product = createProduct(db, { ...VALID, name: "  Tee  ", sku: "  TEE-9  " });

            expect(product.name).toBe("Tee");
            expect(product.sku).toBe("TEE-9");
        });

        test("treats a blank sku as absent rather than storing an empty string", () => {
            const product = createProduct(db, { ...VALID, sku: "   " });

            expect(product.sku).toBeNull();
        });

        test("allows several products with no sku", () => {
            createProduct(db, { ...VALID, sku: null });
            createProduct(db, { ...VALID, name: "Mug", sku: null });

            expect(listProducts(db)).toHaveLength(2);
        });

        test.each([
            ["a blank name", { name: "   " }, /name is required/i],
            ["a zero price", { price: 0 }, /price must be greater than 0/i],
            ["a negative price", { price: -5 }, /price must be greater than 0/i],
            ["negative stock", { stock_quantity: -1 }, /stock.*cannot be negative/i],
            ["fractional stock", { stock_quantity: 1.5 }, /stock.*whole number/i],
        ])("rejects %s", (_label, patch, expected) => {
            expect(() => createProduct(db, { ...VALID, ...patch })).toThrow(expected);
        });

        test("reports a validation failure as a 400, not a crash", () => {
            try {
                createProduct(db, { ...VALID, price: 0 });
                expect.unreachable("should have thrown");
            } catch (err) {
                expect(err).toBeInstanceOf(AppError);
                expect((err as AppError).status).toBe(400);
            }
        });

        test("turns a duplicate sku into a readable error naming the sku", () => {
            createProduct(db, VALID);

            expect(() => createProduct(db, { ...VALID, name: "Other" })).toThrow(
                /TEE-001.*already in use/i
            );
        });

        test("leaves nothing behind when the sku is a duplicate", () => {
            createProduct(db, VALID);

            expect(() => createProduct(db, { ...VALID, name: "Other" })).toThrow();

            // The failed create must not have written a product or a movement.
            expect(countRows(db, "products")).toBe(1);
            expect(countRows(db, "stock_movements")).toBe(1);
        });

        test("records an opening movement even when stock starts at zero", () => {
            const product = createProduct(db, { ...VALID, stock_quantity: 0 });

            expect(listMovementsForProduct(db, product.id)).toHaveLength(1);
        });
    });

    describe("getProductOrThrow", () => {
        test("returns the product", () => {
            const { id } = createProduct(db, VALID);

            expect(getProductOrThrow(db, id).id).toBe(id);
        });

        test("throws a 404 when it does not exist", () => {
            try {
                getProductOrThrow(db, 999);
                expect.unreachable("should have thrown");
            } catch (err) {
                expect(err).toBeInstanceOf(AppError);
                expect((err as AppError).status).toBe(404);
            }
        });
    });

    describe("updateProductDetails", () => {
        test("applies the change and leaves other fields alone", () => {
            const { id } = createProduct(db, VALID);

            const updated = updateProductDetails(db, id, { price: 24.5 });

            expect(updated).toMatchObject({ price: 24.5, name: "Classic Tee" });
        });

        test("validates the fields it is given", () => {
            const { id } = createProduct(db, VALID);

            expect(() => updateProductDetails(db, id, { price: -1 })).toThrow(
                /price must be greater than 0/i
            );
        });

        test("ignores fields it is not given", () => {
            const { id } = createProduct(db, VALID);

            // A missing price must not be validated as though it were 0.
            expect(() => updateProductDetails(db, id, { name: "Renamed" })).not.toThrow();
        });

        test("rejects a sku already used by another product", () => {
            createProduct(db, VALID);
            const { id } = createProduct(db, { ...VALID, name: "Mug", sku: "MUG-001" });

            expect(() => updateProductDetails(db, id, { sku: "TEE-001" })).toThrow(
                /already in use/i
            );
        });

        test("lets a product keep its own sku", () => {
            const { id } = createProduct(db, VALID);

            expect(() => updateProductDetails(db, id, { sku: "TEE-001" })).not.toThrow();
        });

        test("throws a 404 for a product that does not exist", () => {
            expect(() => updateProductDetails(db, 999, { name: "X" })).toThrow(AppError);
        });

        test("does not write a stock movement for a plain detail edit", () => {
            const { id } = createProduct(db, VALID);

            updateProductDetails(db, id, { name: "Renamed" });

            expect(listMovementsForProduct(db, id)).toHaveLength(1);
        });
    });

    describe("archiveProductById", () => {
        test("removes the product from the active list", () => {
            const { id } = createProduct(db, VALID);

            archiveProductById(db, id);

            expect(listProducts(db)).toHaveLength(0);
        });

        test("throws a 404 for a product that does not exist", () => {
            expect(() => archiveProductById(db, 999)).toThrow(AppError);
        });

        test("rejects archiving something already archived", () => {
            const { id } = createProduct(db, VALID);
            archiveProductById(db, id);

            expect(() => archiveProductById(db, id)).toThrow(/already archived/i);
        });
    });

    describe("adjustStockWithReason", () => {
        test("changes stock and logs the movement together", () => {
            const { id } = createProduct(db, VALID);

            const updated = adjustStockWithReason(db, id, 10, "adjustment");

            expect(updated.stock_quantity).toBe(60);
            expect(listMovementsForProduct(db, id)[0]).toMatchObject({
                quantity_change: 10,
                reason: "adjustment",
            });
        });

        test("accepts a negative delta", () => {
            const { id } = createProduct(db, VALID);

            expect(adjustStockWithReason(db, id, -20, "adjustment").stock_quantity).toBe(30);
        });

        test("refuses to take stock below zero", () => {
            const { id } = createProduct(db, VALID);

            expect(() => adjustStockWithReason(db, id, -51, "adjustment")).toThrow(
                /only 50 in stock/i
            );
        });

        test("writes no movement when the adjustment is refused", () => {
            const { id } = createProduct(db, VALID);

            expect(() => adjustStockWithReason(db, id, -51, "adjustment")).toThrow();

            // Only the opening movement should remain.
            expect(listMovementsForProduct(db, id)).toHaveLength(1);
            expect(getProductOrThrow(db, id).stock_quantity).toBe(50);
        });

        test("rejects a zero delta as a no-op", () => {
            const { id } = createProduct(db, VALID);

            expect(() => adjustStockWithReason(db, id, 0, "adjustment")).toThrow(/must not be zero/i);
        });

        test("throws a 404 for a product that does not exist", () => {
            expect(() => adjustStockWithReason(db, 999, 5, "adjustment")).toThrow(AppError);
        });
    });
});

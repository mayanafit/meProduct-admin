import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import {
    listProducts,
    listArchivedProducts,
    getProductById,
    getProductBySku,
    insertProduct,
    updateProduct,
    archiveProduct,
    adjustStock,
    searchProducts,
} from "../../src/repositories/product.js";
import { createTestDb, seedTestProducts } from "../helpers/testDb.js";

const TEE = {
    name: "Classic Tee",
    sku: "TEE-001",
    price: 19.99,
    description: "Cotton tee.",
    stock_quantity: 50,
};

describe("product repository", () => {
    let db: DB;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        db.close();
    });

    describe("insertProduct / getProductById", () => {
        test("round-trips a product", () => {
            const id = insertProduct(db, TEE);
            const found = getProductById(db, id);

            expect(found).toMatchObject({
                id,
                name: "Classic Tee",
                sku: "TEE-001",
                price: 19.99,
                description: "Cotton tee.",
                stock_quantity: 50,
                archived_at: null,
            });
        });

        test("accepts a null description and sku", () => {
            const id = insertProduct(db, { ...TEE, sku: null, description: null });

            expect(getProductById(db, id)).toMatchObject({ sku: null, description: null });
        });

        test("rejects a duplicate sku", () => {
            insertProduct(db, TEE);

            expect(() => insertProduct(db, { ...TEE, name: "Other" })).toThrow(/UNIQUE/i);
        });

        test("returns undefined for an id that does not exist", () => {
            expect(getProductById(db, 999)).toBeUndefined();
        });
    });

    describe("getProductBySku", () => {
        test("finds a product by its sku", () => {
            const id = insertProduct(db, TEE);

            expect(getProductBySku(db, "TEE-001")).toMatchObject({ id });
        });

        test("returns undefined for an unknown sku", () => {
            expect(getProductBySku(db, "NOPE-001")).toBeUndefined();
        });
    });

    describe("listProducts", () => {
        test("returns every active product", () => {
            seedTestProducts(db);

            expect(listProducts(db)).toHaveLength(3);
        });

        test("returns an empty array when there are none", () => {
            expect(listProducts(db)).toEqual([]);
        });
    });

    describe("searchProducts", () => {
        beforeEach(() => {
            // Fixture: Classic Tee / TEE-001 / "Cotton tee.",
            //          Ceramic Mug / MUG-001 / "12oz mug.",
            //          Sold Out Hat / HAT-001 / null description
            seedTestProducts(db);
        });

        test("matches on name", () => {
            expect(searchProducts(db, "tee").map((p) => p.name)).toContain("Classic Tee");
        });

        test("matches on sku", () => {
            expect(searchProducts(db, "MUG-001").map((p) => p.name)).toEqual(["Ceramic Mug"]);
        });

        test("matches on description", () => {
            expect(searchProducts(db, "12oz").map((p) => p.name)).toEqual(["Ceramic Mug"]);
        });

        test("is case-insensitive", () => {
            expect(searchProducts(db, "CERAMIC")).toHaveLength(1);
            expect(searchProducts(db, "ceramic")).toHaveLength(1);
        });

        test("matches a substring, not just a whole word", () => {
            expect(searchProducts(db, "eram").map((p) => p.name)).toEqual(["Ceramic Mug"]);
        });

        test("tolerates a product with no description or sku", () => {
            // Sold Out Hat has description null; the LIKE must not drop the row
            // via NULL propagation.
            expect(searchProducts(db, "hat").map((p) => p.name)).toEqual(["Sold Out Hat"]);
        });

        test("excludes archived products", () => {
            const teeId = getProductBySku(db, "TEE-001")!.id;
            archiveProduct(db, teeId);

            expect(searchProducts(db, "tee")).toEqual([]);
        });

        test("returns an empty array when nothing matches", () => {
            expect(searchProducts(db, "xylophone")).toEqual([]);
        });

        test("returns everything active for a blank query", () => {
            expect(searchProducts(db, "   ")).toHaveLength(3);
        });

        test("caps the number of results", () => {
            for (let i = 0; i < 20; i++) {
                insertProduct(db, { ...TEE, name: `Bulk Tee ${i}`, sku: `BULK-${i}` });
            }

            expect(searchProducts(db, "tee").length).toBeLessThanOrEqual(10);
        });

        test("treats LIKE wildcards in the query as literal text", () => {
            // A query of "%" must not match everything.
            expect(searchProducts(db, "%")).toEqual([]);
            expect(searchProducts(db, "_")).toEqual([]);
        });
    });

    describe("updateProduct", () => {
        test("changes only the fields it is given", () => {
            const id = insertProduct(db, TEE);

            updateProduct(db, id, { price: 24.5 });

            expect(getProductById(db, id)).toMatchObject({
                price: 24.5,
                name: "Classic Tee",
                sku: "TEE-001",
                description: "Cotton tee.",
                stock_quantity: 50,
            });
        });

        test("can clear a nullable field", () => {
            const id = insertProduct(db, TEE);

            updateProduct(db, id, { description: null });

            expect(getProductById(db, id)?.description).toBeNull();
        });

        test("is a no-op when given no fields", () => {
            const id = insertProduct(db, TEE);

            expect(() => updateProduct(db, id, {})).not.toThrow();
            expect(getProductById(db, id)).toMatchObject({ name: "Classic Tee" });
        });

        test("reports whether a row was actually updated", () => {
            const id = insertProduct(db, TEE);

            expect(updateProduct(db, id, { price: 1 })).toBe(true);
            expect(updateProduct(db, 999, { price: 1 })).toBe(false);
        });
    });

    describe("archiveProduct", () => {
        test("hides the product from listProducts", () => {
            const [teeId] = seedTestProducts(db);

            archiveProduct(db, teeId!);

            expect(listProducts(db).map((p) => p.id)).not.toContain(teeId);
            expect(listProducts(db)).toHaveLength(2);
        });

        test("keeps the product fetchable by id, so order history still resolves", () => {
            const [teeId] = seedTestProducts(db);

            archiveProduct(db, teeId!);

            const found = getProductById(db, teeId!);
            expect(found).toBeDefined();
            expect(found?.archived_at).not.toBeNull();
        });

        test("surfaces the archived product through listArchivedProducts", () => {
            const [teeId] = seedTestProducts(db);

            archiveProduct(db, teeId!);

            expect(listArchivedProducts(db).map((p) => p.id)).toEqual([teeId]);
        });

        test("reports whether a row was actually archived", () => {
            const [teeId] = seedTestProducts(db);

            expect(archiveProduct(db, teeId!)).toBe(true);
            expect(archiveProduct(db, 999)).toBe(false);
        });
    });

    describe("adjustStock", () => {
        test("applies a positive delta", () => {
            const id = insertProduct(db, TEE);

            adjustStock(db, id, 5);

            expect(getProductById(db, id)?.stock_quantity).toBe(55);
        });

        test("applies a negative delta", () => {
            const id = insertProduct(db, TEE);

            adjustStock(db, id, -20);

            expect(getProductById(db, id)?.stock_quantity).toBe(30);
        });

        test("refuses to drive stock below zero", () => {
            const id = insertProduct(db, TEE);

            expect(() => adjustStock(db, id, -51)).toThrow();
            expect(getProductById(db, id)?.stock_quantity).toBe(50);
        });
    });
});

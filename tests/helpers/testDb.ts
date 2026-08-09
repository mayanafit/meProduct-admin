import type { Database as DB } from "better-sqlite3";
import { createDatabase, initSchema } from "../../src/db/index.js";

/**
 * A fresh, isolated in-memory database with the schema applied. Call this in
 * `beforeEach` so no test can see another test's rows.
 */
export function createTestDb(): DB {
    const db = createDatabase(":memory:");
    initSchema(db);
    return db;
}

export interface TestProduct {
    name: string;
    sku: string;
    price: number;
    description: string | null;
    stock_quantity: number;
}

/**
 * A small, fixed fixture. Deliberately not the real seed file — tests assert on
 * these exact values, and they shouldn't break when the seed data changes.
 */
export const TEST_PRODUCTS: readonly TestProduct[] = [
    { name: "Classic Tee", sku: "TEE-001", price: 19.99, description: "Cotton tee.", stock_quantity: 50 },
    { name: "Ceramic Mug", sku: "MUG-001", price: 9.99, description: "12oz mug.", stock_quantity: 10 },
    { name: "Sold Out Hat", sku: "HAT-001", price: 24.0, description: null, stock_quantity: 0 },
];

/**
 * Inserts the fixture products plus their matching `initial_stock` movements,
 * mirroring what the product service does for a real create.
 * Returns the inserted ids, in fixture order.
 */
export function seedTestProducts(
    db: DB,
    products: readonly TestProduct[] = TEST_PRODUCTS
): number[] {
    const insertProduct = db.prepare(
        `INSERT INTO products (name, sku, price, description, stock_quantity)
         VALUES (@name, @sku, @price, @description, @stock_quantity)`
    );
    const insertMovement = db.prepare(
        `INSERT INTO stock_movements (product_id, quantity_change, reason)
         VALUES (?, ?, 'initial_stock')`
    );

    const insertAll = db.transaction((rows: readonly TestProduct[]): number[] =>
        rows.map((row) => {
            const id = Number(insertProduct.run(row).lastInsertRowid);
            insertMovement.run(id, row.stock_quantity);
            return id;
        })
    );

    return insertAll(products);
}

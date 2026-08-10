import type { Database as DB } from "better-sqlite3";
import type { NewProduct, Product, ProductUpdate } from "../types.js";

/**
 * SQL for the `products` table. No validation and no business rules — those
 * belong in `services/product.ts`. Every function takes the database so callers
 * (including tests) control which one they hit.
 */

const COLUMNS = `id, name, sku, price, description, stock_quantity, created_at, archived_at`;

/** Active products only. Archived ones are excluded from every list view. */
export function listProducts(db: DB): Product[] {
    return db
        .prepare(
            `SELECT ${COLUMNS} FROM products
             WHERE archived_at IS NULL
             ORDER BY name COLLATE NOCASE`
        )
        .all() as Product[];
}

export function listArchivedProducts(db: DB): Product[] {
    return db
        .prepare(
            `SELECT ${COLUMNS} FROM products
             WHERE archived_at IS NOT NULL
             ORDER BY archived_at DESC`
        )
        .all() as Product[];
}

/**
 * Looks up by id regardless of archived state — order history references
 * products that may since have been archived.
 */
export function getProductById(db: DB, id: number): Product | undefined {
    return db.prepare(`SELECT ${COLUMNS} FROM products WHERE id = ?`).get(id) as
        | Product
        | undefined;
}

export function getProductBySku(db: DB, sku: string): Product | undefined {
    return db.prepare(`SELECT ${COLUMNS} FROM products WHERE sku = ?`).get(sku) as
        | Product
        | undefined;
}

/** How many matches the shop assistant is ever handed in one reply. */
const SEARCH_LIMIT = 10;

/**
 * Free-text search over active products, for the shop assistant.
 *
 * `%` and `_` in the query are escaped so a user typing "%" gets no matches
 * rather than the whole catalogue. `COALESCE` keeps rows whose sku or
 * description is NULL — without it, NULL propagation would silently drop them.
 * A blank query lists everything active.
 */
export function searchProducts(db: DB, query: string): Product[] {
    const trimmed = query.trim();

    if (trimmed === "") {
        return db
            .prepare(
                `SELECT ${COLUMNS} FROM products
                 WHERE archived_at IS NULL
                 ORDER BY name COLLATE NOCASE
                 LIMIT ?`
            )
            .all(SEARCH_LIMIT) as Product[];
    }

    const pattern = `%${trimmed.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

    return db
        .prepare(
            `SELECT ${COLUMNS} FROM products
             WHERE archived_at IS NULL
               AND (
                 name LIKE @pattern ESCAPE '\\'
                 OR COALESCE(sku, '') LIKE @pattern ESCAPE '\\'
                 OR COALESCE(description, '') LIKE @pattern ESCAPE '\\'
               )
             ORDER BY name COLLATE NOCASE
             LIMIT @limit`
        )
        .all({ pattern, limit: SEARCH_LIMIT }) as Product[];
}

/** Returns the new product's id. Throws on a duplicate sku. */
export function insertProduct(db: DB, product: NewProduct): number {
    const result = db
        .prepare(
            `INSERT INTO products (name, sku, price, description, stock_quantity)
             VALUES (@name, @sku, @price, @description, @stock_quantity)`
        )
        .run({
            name: product.name,
            sku: product.sku ?? null,
            price: product.price,
            description: product.description ?? null,
            stock_quantity: product.stock_quantity,
        });

    return Number(result.lastInsertRowid);
}

/** Whitelisted so the dynamic SET clause can never interpolate caller input. */
const UPDATABLE_COLUMNS = ["name", "sku", "price", "description", "stock_quantity"] as const;

/**
 * Updates only the fields present on `fields`; omitted columns keep their
 * current values. Returns false if no such product exists.
 */
export function updateProduct(db: DB, id: number, fields: ProductUpdate): boolean {
    const present = UPDATABLE_COLUMNS.filter((column) =>
        Object.prototype.hasOwnProperty.call(fields, column)
    );

    if (present.length === 0) {
        return getProductById(db, id) !== undefined;
    }

    const assignments = present.map((column) => `${column} = ?`).join(", ");
    // `exactOptionalPropertyTypes` means a present key is never `undefined`.
    const values = present.map((column) => fields[column]) as (string | number | null)[];

    const result = db
        .prepare(`UPDATE products SET ${assignments} WHERE id = ?`)
        .run(...values, id);

    return result.changes > 0;
}

/** Soft delete. Returns false if the product does not exist or is already archived. */
export function archiveProduct(db: DB, id: number): boolean {
    const result = db
        .prepare(
            `UPDATE products SET archived_at = datetime('now')
             WHERE id = ? AND archived_at IS NULL`
        )
        .run(id);

    return result.changes > 0;
}

/**
 * Applies a signed delta to stock. The schema's `stock_quantity >= 0` CHECK
 * makes an over-decrement throw rather than silently going negative.
 */
export function adjustStock(db: DB, id: number, delta: number): boolean {
    const result = db
        .prepare(`UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?`)
        .run(delta, id);

    return result.changes > 0;
}

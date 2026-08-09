import type { Database as DB } from "better-sqlite3";
import type { NewStockMovement, StockMovement } from "../types.js";

/**
 * SQL for `stock_movements`, the append-only audit log of stock changes.
 * Nothing here updates or deletes — history is written once.
 */

const COLUMNS = `id, product_id, quantity_change, reason, reference_id, created_at`;

/** Returns the new movement's id. */
export function recordMovement(db: DB, movement: NewStockMovement): number {
    const result = db
        .prepare(
            `INSERT INTO stock_movements (product_id, quantity_change, reason, reference_id)
             VALUES (@product_id, @quantity_change, @reason, @reference_id)`
        )
        .run({
            product_id: movement.productId,
            quantity_change: movement.quantityChange,
            reason: movement.reason,
            reference_id: movement.referenceId ?? null,
        });

    return Number(result.lastInsertRowid);
}

/**
 * Newest first. `created_at` only has second resolution, so id breaks ties —
 * without it, movements written in the same second come back in arbitrary order.
 */
export function listMovementsForProduct(db: DB, productId: number): StockMovement[] {
    return db
        .prepare(
            `SELECT ${COLUMNS} FROM stock_movements
             WHERE product_id = ?
             ORDER BY created_at DESC, id DESC`
        )
        .all(productId) as StockMovement[];
}

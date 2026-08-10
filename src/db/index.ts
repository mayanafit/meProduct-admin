import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { randomUUID } from "node:crypto";

/**
 * Opens a database connection. Callers own the instance and pass it down to
 * repositories, which keeps tests free to run against an isolated `:memory:`
 * database instead of the real file.
 */
export function createDatabase(path: string): DB {
    const db = new Database(path);

    db.pragma("foreign_keys = ON");

    // WAL needs a file on disk; an in-memory database silently stays in
    // "memory" journal mode, so don't bother asking.
    if (path !== ":memory:") {
        db.pragma("journal_mode = WAL");
    }

    return db;
}

export function initSchema(db: DB): void {
    db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sku TEXT UNIQUE,
      price REAL NOT NULL,
      description TEXT,
      -- Enforced here rather than in a repository so every write path,
      -- including order placement, inherits the invariant.
      stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- NULL = active. Products are archived rather than deleted: their
      -- stock_movements and order_items rows reference them, and that history
      -- is worth more than the ability to remove a row.
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity_change INTEGER NOT NULL,
      reason TEXT NOT NULL,
      reference_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT,
      customer_email TEXT,
      -- Unguessable handle for the customer's confirmation page. Sequential
      -- ids would let anyone enumerate other people's orders.
      reference TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_stock_movements_product_id
      ON stock_movements(product_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id
      ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_product_id
      ON order_items(product_id);
  `);

    runMigrations(db);
}

/** True when `table` already has `column`. */
function hasColumn(db: DB, table: string, column: string): boolean {
    const found = db
        .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
        .get(table, column);

    return found !== undefined;
}

/**
 * Adds a column only if it's missing. `table` and `column` are interpolated,
 * so they must always be literals from this file — never caller input.
 */
function ensureColumn(db: DB, table: string, column: string, definition: string): boolean {
    if (hasColumn(db, table, column)) return false;

    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
}

/**
 * Brings an existing database up to the current schema.
 *
 * `initSchema` uses CREATE TABLE IF NOT EXISTS and so can never alter a table
 * that already exists — without this, adding a column would mean deleting the
 * database and reseeding, losing real orders. Idempotent: safe on every boot.
 */
export function runMigrations(db: DB): void {
    ensureColumn(db, "orders", "customer_email", "TEXT");

    // SQLite can't ALTER in a UNIQUE column, so the constraint is added
    // separately as a unique index — equivalent for our purposes.
    if (ensureColumn(db, "orders", "reference", "TEXT")) {
        db.exec(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_reference ON orders(reference)`
        );
    }

    backfillOrderReferences(db);
}

/** Gives any pre-existing order a reference, so every order has a lookup key. */
function backfillOrderReferences(db: DB): void {
    const missing = db
        .prepare(`SELECT id FROM orders WHERE reference IS NULL`)
        .all() as { id: number }[];

    if (missing.length === 0) return;

    const assign = db.prepare(`UPDATE orders SET reference = ? WHERE id = ?`);
    const assignAll = db.transaction((rows: { id: number }[]) => {
        for (const row of rows) assign.run(randomUUID(), row.id);
    });

    assignAll(missing);
}

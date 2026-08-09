import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";

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
      stock_quantity INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
}

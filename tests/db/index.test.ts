import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { createDatabase, initSchema } from "../../src/db/index.js";

describe("createDatabase", () => {
    let db: DB;

    beforeEach(() => {
        db = createDatabase(":memory:");
    });

    afterEach(() => {
        db.close();
    });

    test("enforces foreign keys", () => {
        expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });

    test("does not attempt WAL on an in-memory database", () => {
        // WAL is meaningless without a file on disk; SQLite reports "memory".
        expect(db.pragma("journal_mode", { simple: true })).toBe("memory");
    });
});

describe("initSchema", () => {
    let db: DB;

    beforeEach(() => {
        db = createDatabase(":memory:");
        initSchema(db);
    });

    afterEach(() => {
        db.close();
    });

    test("creates every table the app needs", () => {
        const names = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((row) => (row as { name: string }).name);

        expect(names).toEqual(
            expect.arrayContaining(["products", "stock_movements", "orders", "order_items"])
        );
    });

    test("indexes the foreign keys that list queries join on", () => {
        const names = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
            .all()
            .map((row) => (row as { name: string }).name);

        expect(names).toEqual(
            expect.arrayContaining([
                "idx_stock_movements_product_id",
                "idx_order_items_order_id",
                "idx_order_items_product_id",
            ])
        );
    });

    test("is idempotent", () => {
        expect(() => initSchema(db)).not.toThrow();
    });

    test("rejects an order_item pointing at a product that does not exist", () => {
        db.prepare("INSERT INTO orders (customer_name) VALUES ('Ada')").run();

        expect(() =>
            db
                .prepare(
                    "INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (1, 999, 1, 9.99)"
                )
                .run()
        ).toThrow(/FOREIGN KEY/i);
    });

    test("rejects an unknown order status", () => {
        expect(() =>
            db.prepare("INSERT INTO orders (status) VALUES ('teleported')").run()
        ).toThrow(/CHECK/i);
    });

    test("defaults a new order to pending", () => {
        const id = db.prepare("INSERT INTO orders (customer_name) VALUES ('Ada')").run()
            .lastInsertRowid;
        const order = db.prepare("SELECT status FROM orders WHERE id = ?").get(id) as {
            status: string;
        };

        expect(order.status).toBe("pending");
    });

    test("treats a new product as active", () => {
        db.prepare("INSERT INTO products (name, sku, price) VALUES ('Tee', 'TEE-1', 9.99)").run();
        const product = db.prepare("SELECT archived_at FROM products WHERE id = 1").get() as {
            archived_at: string | null;
        };

        // NULL archived_at is what marks a product as still on sale.
        expect(product.archived_at).toBeNull();
    });

    test("stores a customer email on an order", () => {
        db.prepare(
            "INSERT INTO orders (customer_name, customer_email) VALUES ('Ada', 'ada@example.com')"
        ).run();
        const order = db.prepare("SELECT customer_email FROM orders WHERE id = 1").get() as {
            customer_email: string;
        };

        expect(order.customer_email).toBe("ada@example.com");
    });

    test("rejects two orders sharing a reference", () => {
        db.prepare("INSERT INTO orders (reference) VALUES ('ref-1')").run();

        expect(() => db.prepare("INSERT INTO orders (reference) VALUES ('ref-1')").run()).toThrow(
            /UNIQUE/i
        );
    });

    test("stores a customer name on an order", () => {
        db.prepare("INSERT INTO orders (customer_name) VALUES ('Ada Lovelace')").run();
        const order = db.prepare("SELECT customer_name FROM orders WHERE id = 1").get() as {
            customer_name: string;
        };

        expect(order.customer_name).toBe("Ada Lovelace");
    });
});

import { describe, test, expect, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { createDatabase, initSchema, runMigrations } from "../../src/db/index.js";

/**
 * `initSchema` uses CREATE TABLE IF NOT EXISTS, so it can never alter a table
 * that already exists. These tests stand up a pre-Phase-5 `orders` table with
 * real rows in it and prove the migration adds the new columns without
 * destroying anything — the alternative was delete-and-reseed.
 */
function legacyDb(): DB {
    const db = createDatabase(":memory:");

    // The orders table exactly as it was before customer_email / reference.
    db.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
    db.prepare("INSERT INTO orders (customer_name, status) VALUES ('tenten', 'shipped')").run();
    db.prepare("INSERT INTO orders (customer_name, status) VALUES ('Ada', 'pending')").run();

    return db;
}

function columnsOf(db: DB, table: string): string[] {
    return db
        .prepare(`SELECT name FROM pragma_table_info(?)`)
        .all(table)
        .map((row) => (row as { name: string }).name);
}

describe("runMigrations", () => {
    let db: DB;

    afterEach(() => {
        db.close();
    });

    test("adds the new columns to a table that predates them", () => {
        db = legacyDb();
        expect(columnsOf(db, "orders")).not.toContain("customer_email");

        runMigrations(db);

        expect(columnsOf(db, "orders")).toEqual(
            expect.arrayContaining(["customer_email", "reference"])
        );
    });

    test("preserves existing orders untouched", () => {
        db = legacyDb();

        runMigrations(db);

        const rows = db
            .prepare("SELECT id, customer_name, status FROM orders ORDER BY id")
            .all();
        expect(rows).toEqual([
            { id: 1, customer_name: "tenten", status: "shipped" },
            { id: 2, customer_name: "Ada", status: "pending" },
        ]);
    });

    test("backfills a distinct reference onto every existing order", () => {
        db = legacyDb();

        runMigrations(db);

        const refs = db
            .prepare("SELECT reference FROM orders")
            .all()
            .map((row) => (row as { reference: string | null }).reference);

        expect(refs.every((r) => typeof r === "string" && r.length > 0)).toBe(true);
        expect(new Set(refs).size).toBe(refs.length);
    });

    test("is safe to run repeatedly", () => {
        db = legacyDb();
        runMigrations(db);
        const before = db.prepare("SELECT reference FROM orders WHERE id = 1").get();

        expect(() => runMigrations(db)).not.toThrow();

        // A second run must not re-roll references that were already assigned.
        expect(db.prepare("SELECT reference FROM orders WHERE id = 1").get()).toEqual(before);
    });

    test("is a no-op on a database created fresh by initSchema", () => {
        db = createDatabase(":memory:");
        initSchema(db);

        expect(() => runMigrations(db)).not.toThrow();
        expect(columnsOf(db, "orders")).toEqual(
            expect.arrayContaining(["customer_email", "reference"])
        );
    });

    test("initSchema runs the migration itself", () => {
        db = legacyDb();

        initSchema(db);

        expect(columnsOf(db, "orders")).toContain("reference");
    });
});

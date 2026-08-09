import { readFileSync } from "node:fs";
import path from "node:path";
import type { Database as DB } from "better-sqlite3";
import { config } from "../config/env.js";
import { createDatabase, initSchema } from "./index.js";

interface ProductSeed {
    name: string;
    sku: string;
    price: number;
    description?: string;
    stock_quantity: number;
}

function loadProducts(): ProductSeed[] {
    const filePath = path.join(process.cwd(), "src/db/seeds/products.json");
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ProductSeed[];
}

function seedProducts(db: DB): void {
    const products = loadProducts();

    const insertProduct = db.prepare(
        "INSERT INTO products (name, sku, price, description, stock_quantity) VALUES (@name, @sku, @price, @description, @stock_quantity)"
    );

    const insertMovement = db.prepare(
        "INSERT INTO stock_movements (product_id, quantity_change, reason) VALUES (?, ?, 'initial_stock')"
    );

    const insertMany = db.transaction((rows: ProductSeed[]) => {
        for (const row of rows) {
            const result = insertProduct.run({
                name: row.name,
                sku: row.sku,
                price: row.price,
                description: row.description ?? null,
                stock_quantity: row.stock_quantity,
            });

            insertMovement.run(result.lastInsertRowid, row.stock_quantity);
        }
    });

    insertMany(products);
    console.log(`Seeded ${products.length} products.`);
}

function main(): void {
    const db = createDatabase(config.DB_PATH);
    initSchema(db);

    const existing = db.prepare("SELECT COUNT(*) as count FROM products").get() as { count: number };

    if (existing.count > 0) {
        console.log(
            `Skipped: products table already has ${existing.count} row(s). Delete ${config.DB_PATH} to reseed from scratch.`
        );
        return;
    }

    seedProducts(db);
}

main();

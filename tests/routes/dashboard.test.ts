import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import request from "supertest";
import * as cheerio from "cheerio";
import { buildApp } from "../../src/app.js";
import { placeOrder } from "../../src/services/order.js";
import { createProduct } from "../../src/services/product.js";
import { archiveProduct } from "../../src/repositories/product.js";
import { createTestDb, seedTestProducts } from "../helpers/testDb.js";

function $of(html: string): cheerio.CheerioAPI {
    return cheerio.load(html);
}

describe("dashboard", () => {
    let db: DB;
    let teeId: number;
    let mugId: number;

    beforeEach(() => {
        db = createTestDb();
        const ids = seedTestProducts(db);
        teeId = ids[0]!;
        mugId = ids[1]!;
    });

    afterEach(() => {
        db.close();
    });

    test("counts only active products", async () => {
        archiveProduct(db, teeId);

        const res = await request(buildApp(db)).get("/admin");
        const $ = $of(res.text);

        expect(res.status).toBe(200);
        expect($("[data-testid='stat-products']").text()).toContain("2");
    });

    test("lists products at or below the low-stock threshold", async () => {
        // Fixture: Tee 50, Mug 10, Hat 0 — the mug and hat qualify.
        const res = await request(buildApp(db)).get("/admin");
        const $ = $of(res.text);

        const names = $("[data-testid='low-stock-row']")
            .map((_, el) => $(el).text())
            .get()
            .join(" ");

        expect($("[data-testid='low-stock-row']")).toHaveLength(2);
        expect(names).toContain("Ceramic Mug");
        expect(names).toContain("Sold Out Hat");
        expect(names).not.toContain("Classic Tee");
    });

    test("shows a reassuring empty state when stock is healthy", async () => {
        const healthy = createTestDb();
        createProduct(healthy, {
            name: "Plenty",
            sku: "P-1",
            price: 5,
            description: null,
            stock_quantity: 500,
        });

        const res = await request(buildApp(healthy)).get("/admin");

        expect($of(res.text)("[data-testid='low-stock-row']")).toHaveLength(0);
        expect(res.text).toMatch(/stock levels look fine/i);
        healthy.close();
    });

    test("excludes archived products from the low-stock list", async () => {
        // Archiving the mug leaves only the sold-out hat below the threshold.
        archiveProduct(db, mugId);

        const res = await request(buildApp(db)).get("/admin");

        expect($of(res.text)("[data-testid='low-stock-row']")).toHaveLength(1);
    });

    test("shows recent orders newest first", async () => {
        placeOrder(db, { customerName: "Ada", lines: [{ productId: teeId, quantity: 1 }] });
        placeOrder(db, { customerName: "Grace", lines: [{ productId: teeId, quantity: 1 }] });

        const res = await request(buildApp(db)).get("/admin");
        const $ = $of(res.text);
        const rows = $("[data-testid='recent-order-row']");

        expect(rows).toHaveLength(2);
        expect(rows.eq(0).text()).toContain("Grace");
    });

    test("caps the recent order list at five", async () => {
        for (let i = 0; i < 7; i++) {
            placeOrder(db, {
                customerName: `Customer ${i}`,
                lines: [{ productId: teeId, quantity: 1 }],
            });
        }

        const res = await request(buildApp(db)).get("/admin");

        expect($of(res.text)("[data-testid='recent-order-row']")).toHaveLength(5);
    });

    test("shows an empty state when no orders exist", async () => {
        const res = await request(buildApp(db)).get("/admin");

        expect($of(res.text)("[data-testid='recent-order-row']")).toHaveLength(0);
        expect(res.text).toMatch(/no orders yet/i);
    });

    test("counts orders", async () => {
        placeOrder(db, { customerName: "Ada", lines: [{ productId: teeId, quantity: 1 }] });

        const res = await request(buildApp(db)).get("/admin");

        expect($of(res.text)("[data-testid='stat-orders']").text()).toContain("1");
    });
});

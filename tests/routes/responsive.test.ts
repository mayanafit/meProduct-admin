import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import request from "supertest";
import * as cheerio from "cheerio";
import { buildApp } from "../../src/app.js";
import { placeOrder } from "../../src/services/order.js";
import { createTestDb, seedTestProducts } from "../helpers/testDb.js";

/**
 * Every table has to stay inside a horizontally scrollable wrapper *and* carry
 * a min-width. Without the min-width, `w-full` shrinks the table to its
 * container, nothing overflows, the scroll never engages, and columns squash
 * into an unreadable mess on a phone — so both halves are load-bearing.
 */
describe("tables stay scrollable on small screens", () => {
    let db: DB;
    let paths: string[];

    beforeEach(() => {
        db = createTestDb();
        const teeId = seedTestProducts(db)[0]!;
        const order = placeOrder(db, {
            customerName: "Ada",
            lines: [{ productId: teeId, quantity: 1 }],
        });

        paths = [
            // Admin
            "/admin/products",
            `/admin/products/${teeId}`,
            "/admin/orders",
            "/admin/orders/new",
            `/admin/orders/${order.id}`,
            // Shop. The cart page is omitted: without a session it renders its
            // empty state rather than a table. It's covered in shop.test.ts.
            `/order/${order.reference}`,
        ];
    });

    afterEach(() => {
        db.close();
    });

    test("every page under test actually renders a table", async () => {
        const app = buildApp(db);

        for (const path of paths) {
            const $ = cheerio.load((await request(app).get(path)).text);
            expect($("table").length, `${path} rendered no table`).toBeGreaterThan(0);
        }
    });

    test("each table sits in an overflow-x-auto wrapper", async () => {
        const app = buildApp(db);

        for (const path of paths) {
            const $ = cheerio.load((await request(app).get(path)).text);

            $("table").each((_, el) => {
                const wrapper = $(el).parent();
                expect(
                    wrapper.attr("class") ?? "",
                    `table on ${path} is not in a scrollable wrapper`
                ).toContain("overflow-x-auto");
            });
        }
    });

    test("each table declares a min-width so the wrapper can overflow", async () => {
        const app = buildApp(db);

        for (const path of paths) {
            const $ = cheerio.load((await request(app).get(path)).text);

            $("table").each((_, el) => {
                expect(
                    $(el).attr("class") ?? "",
                    `table on ${path} has no min-width and will squash instead of scroll`
                ).toMatch(/min-w-\[\d+px\]/);
            });
        }
    });

    test("the layout declares a responsive viewport", async () => {
        const $ = cheerio.load((await request(buildApp(db)).get("/")).text);

        expect($("meta[name='viewport']").attr("content")).toContain("width=device-width");
    });
});

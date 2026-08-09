import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import {
    listOrders,
    getOrderById,
    getOrderWithItems,
    insertOrder,
    insertOrderItem,
    updateOrderStatus,
} from "../../src/repositories/order.js";
import { createTestDb, seedTestProducts } from "../helpers/testDb.js";

describe("order repository", () => {
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

    describe("insertOrder / getOrderById", () => {
        test("round-trips an order, defaulting to pending", () => {
            const id = insertOrder(db, "Ada Lovelace");

            expect(getOrderById(db, id)).toMatchObject({
                id,
                customer_name: "Ada Lovelace",
                status: "pending",
            });
        });

        test("accepts an order with no customer name", () => {
            const id = insertOrder(db, null);

            expect(getOrderById(db, id)?.customer_name).toBeNull();
        });

        test("returns undefined for an id that does not exist", () => {
            expect(getOrderById(db, 999)).toBeUndefined();
        });
    });

    describe("getOrderWithItems", () => {
        test("returns line items joined to their product names", () => {
            const id = insertOrder(db, "Ada");
            insertOrderItem(db, { orderId: id, productId: teeId, quantity: 2, unitPrice: 19.99 });
            insertOrderItem(db, { orderId: id, productId: mugId, quantity: 1, unitPrice: 9.99 });

            const order = getOrderWithItems(db, id);

            expect(order?.items).toHaveLength(2);
            expect(order?.items.map((i) => i.product_name)).toEqual(
                expect.arrayContaining(["Classic Tee", "Ceramic Mug"])
            );
        });

        test("computes the total from quantity times snapshotted unit price", () => {
            const id = insertOrder(db, "Ada");
            insertOrderItem(db, { orderId: id, productId: teeId, quantity: 2, unitPrice: 19.99 });
            insertOrderItem(db, { orderId: id, productId: mugId, quantity: 3, unitPrice: 9.99 });

            expect(getOrderWithItems(db, id)?.total).toBeCloseTo(2 * 19.99 + 3 * 9.99, 5);
        });

        test("returns an order with no items as an empty list and zero total", () => {
            const id = insertOrder(db, "Ada");
            const order = getOrderWithItems(db, id);

            expect(order?.items).toEqual([]);
            expect(order?.total).toBe(0);
        });

        test("returns undefined for an id that does not exist", () => {
            expect(getOrderWithItems(db, 999)).toBeUndefined();
        });
    });

    describe("listOrders", () => {
        test("rolls up item count and total per order", () => {
            const id = insertOrder(db, "Ada");
            insertOrderItem(db, { orderId: id, productId: teeId, quantity: 2, unitPrice: 19.99 });
            insertOrderItem(db, { orderId: id, productId: mugId, quantity: 1, unitPrice: 9.99 });

            const [summary] = listOrders(db);

            expect(summary).toMatchObject({ id, item_count: 2 });
            expect(summary?.total).toBeCloseTo(2 * 19.99 + 9.99, 5);
        });

        test("includes an order that has no items yet", () => {
            insertOrder(db, "Ada");

            expect(listOrders(db)).toMatchObject([{ item_count: 0, total: 0 }]);
        });

        test("returns the newest order first", () => {
            insertOrder(db, "First");
            insertOrder(db, "Second");

            expect(listOrders(db).map((o) => o.customer_name)).toEqual(["Second", "First"]);
        });

        test("returns an empty array when there are no orders", () => {
            expect(listOrders(db)).toEqual([]);
        });
    });

    describe("insertOrderItem", () => {
        test("refuses a line against an order that does not exist", () => {
            expect(() =>
                insertOrderItem(db, { orderId: 999, productId: teeId, quantity: 1, unitPrice: 1 })
            ).toThrow(/FOREIGN KEY/i);
        });

        test("refuses a line against a product that does not exist", () => {
            const id = insertOrder(db, "Ada");

            expect(() =>
                insertOrderItem(db, { orderId: id, productId: 999, quantity: 1, unitPrice: 1 })
            ).toThrow(/FOREIGN KEY/i);
        });
    });

    describe("updateOrderStatus", () => {
        test("changes the status", () => {
            const id = insertOrder(db, "Ada");

            expect(updateOrderStatus(db, id, "shipped")).toBe(true);
            expect(getOrderById(db, id)?.status).toBe("shipped");
        });

        test("reports false for an order that does not exist", () => {
            expect(updateOrderStatus(db, 999, "shipped")).toBe(false);
        });
    });
});

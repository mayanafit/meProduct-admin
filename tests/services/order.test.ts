import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { placeOrder, cancelOrder } from "../../src/services/order.js";
import { listOrders, getOrderWithItems } from "../../src/repositories/order.js";
import { getProductById, archiveProduct } from "../../src/repositories/product.js";
import { listMovementsForProduct } from "../../src/repositories/stockMovement.js";
import { updateProductDetails } from "../../src/services/product.js";
import { AppError } from "../../src/errors.js";
import { createTestDb, seedTestProducts } from "../helpers/testDb.js";

function countRows(db: DB, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

describe("order service", () => {
    let db: DB;
    /** Classic Tee, 50 in stock @ 19.99 */
    let teeId: number;
    /** Ceramic Mug, 10 in stock @ 9.99 */
    let mugId: number;
    /** Sold Out Hat, 0 in stock */
    let hatId: number;

    beforeEach(() => {
        db = createTestDb();
        const ids = seedTestProducts(db);
        teeId = ids[0]!;
        mugId = ids[1]!;
        hatId = ids[2]!;
    });

    afterEach(() => {
        db.close();
    });

    describe("placeOrder", () => {
        test("creates the order with its line items", () => {
            const order = placeOrder(db, {
                customerName: "Ada Lovelace",
                lines: [
                    { productId: teeId, quantity: 2 },
                    { productId: mugId, quantity: 1 },
                ],
            });

            expect(order).toMatchObject({ customer_name: "Ada Lovelace", status: "pending" });
            expect(order.items).toHaveLength(2);
            expect(order.total).toBeCloseTo(2 * 19.99 + 9.99, 5);
        });

        test("decrements stock by the ordered quantity", () => {
            placeOrder(db, { customerName: null, lines: [{ productId: teeId, quantity: 3 }] });

            expect(getProductById(db, teeId)?.stock_quantity).toBe(47);
        });

        test("logs one movement per line, tagged with the order id", () => {
            const order = placeOrder(db, {
                customerName: null,
                lines: [{ productId: teeId, quantity: 3 }],
            });

            const [latest] = listMovementsForProduct(db, teeId);
            expect(latest).toMatchObject({
                quantity_change: -3,
                reason: "order",
                reference_id: order.id,
            });
        });

        test("snapshots unit_price so later price changes don't rewrite history", () => {
            const order = placeOrder(db, {
                customerName: null,
                lines: [{ productId: teeId, quantity: 1 }],
            });

            updateProductDetails(db, teeId, { price: 99.99 });

            const reloaded = getOrderWithItems(db, order.id);
            expect(reloaded?.items[0]?.unit_price).toBe(19.99);
            expect(reloaded?.total).toBeCloseTo(19.99, 5);
        });

        test("allows ordering the exact remaining stock", () => {
            placeOrder(db, { customerName: null, lines: [{ productId: mugId, quantity: 10 }] });

            expect(getProductById(db, mugId)?.stock_quantity).toBe(0);
        });

        test("merges duplicate lines for the same product", () => {
            const order = placeOrder(db, {
                customerName: null,
                lines: [
                    { productId: teeId, quantity: 2 },
                    { productId: teeId, quantity: 3 },
                ],
            });

            expect(order.items).toHaveLength(1);
            expect(order.items[0]?.quantity).toBe(5);
            expect(getProductById(db, teeId)?.stock_quantity).toBe(45);
        });

        test("checks merged duplicates against stock as a single total", () => {
            // 6 + 6 passes line-by-line against 10 in stock, but 12 does not.
            expect(() =>
                placeOrder(db, {
                    customerName: null,
                    lines: [
                        { productId: mugId, quantity: 6 },
                        { productId: mugId, quantity: 6 },
                    ],
                })
            ).toThrow(/only 10/i);

            expect(getProductById(db, mugId)?.stock_quantity).toBe(10);
        });

        test("treats a blank customer name as absent", () => {
            const order = placeOrder(db, {
                customerName: "   ",
                lines: [{ productId: teeId, quantity: 1 }],
            });

            expect(order.customer_name).toBeNull();
        });

        describe("rejections", () => {
            test("rejects an order with no lines", () => {
                expect(() => placeOrder(db, { customerName: "Ada", lines: [] })).toThrow(
                    /at least one/i
                );
            });

            test("rejects a non-positive quantity", () => {
                expect(() =>
                    placeOrder(db, { customerName: null, lines: [{ productId: teeId, quantity: 0 }] })
                ).toThrow(/quantity must be at least 1/i);
            });

            test("rejects a fractional quantity", () => {
                expect(() =>
                    placeOrder(db, { customerName: null, lines: [{ productId: teeId, quantity: 1.5 }] })
                ).toThrow(/whole number/i);
            });

            test("rejects a product that does not exist, as a 404", () => {
                try {
                    placeOrder(db, { customerName: null, lines: [{ productId: 999, quantity: 1 }] });
                    expect.unreachable("should have thrown");
                } catch (err) {
                    expect(err).toBeInstanceOf(AppError);
                    expect((err as AppError).status).toBe(404);
                }
            });

            test("rejects an archived product", () => {
                archiveProduct(db, teeId);

                expect(() =>
                    placeOrder(db, { customerName: null, lines: [{ productId: teeId, quantity: 1 }] })
                ).toThrow(/no longer available/i);
            });

            test("rejects insufficient stock, naming the product and what's left", () => {
                expect(() =>
                    placeOrder(db, { customerName: null, lines: [{ productId: mugId, quantity: 11 }] })
                ).toThrow(/Ceramic Mug.*only 10/i);
            });

            test("rejects an out-of-stock product", () => {
                expect(() =>
                    placeOrder(db, { customerName: null, lines: [{ productId: hatId, quantity: 1 }] })
                ).toThrow(/only 0/i);
            });
        });

        describe("atomicity", () => {
            test("persists nothing at all when a later line has insufficient stock", () => {
                expect(() =>
                    placeOrder(db, {
                        customerName: "Ada",
                        lines: [
                            { productId: teeId, quantity: 2 }, // fine
                            { productId: mugId, quantity: 99 }, // fails
                        ],
                    })
                ).toThrow();

                expect(countRows(db, "orders")).toBe(0);
                expect(countRows(db, "order_items")).toBe(0);
                // Only the three initial_stock rows from the fixture.
                expect(countRows(db, "stock_movements")).toBe(3);
                expect(getProductById(db, teeId)?.stock_quantity).toBe(50);
                expect(getProductById(db, mugId)?.stock_quantity).toBe(10);
            });

            test("persists nothing when a later line references a missing product", () => {
                expect(() =>
                    placeOrder(db, {
                        customerName: "Ada",
                        lines: [
                            { productId: teeId, quantity: 2 },
                            { productId: 999, quantity: 1 },
                        ],
                    })
                ).toThrow();

                expect(countRows(db, "orders")).toBe(0);
                expect(getProductById(db, teeId)?.stock_quantity).toBe(50);
            });
        });
    });

    describe("cancelOrder", () => {
        test("restores stock and marks the order cancelled", () => {
            const order = placeOrder(db, {
                customerName: "Ada",
                lines: [
                    { productId: teeId, quantity: 3 },
                    { productId: mugId, quantity: 2 },
                ],
            });

            const cancelled = cancelOrder(db, order.id);

            expect(cancelled.status).toBe("cancelled");
            expect(getProductById(db, teeId)?.stock_quantity).toBe(50);
            expect(getProductById(db, mugId)?.stock_quantity).toBe(10);
        });

        test("logs the reversal as its own movement rather than deleting history", () => {
            const order = placeOrder(db, {
                customerName: null,
                lines: [{ productId: teeId, quantity: 3 }],
            });

            cancelOrder(db, order.id);

            const movements = listMovementsForProduct(db, teeId);
            expect(movements.map((m) => m.reason)).toEqual([
                "order_cancelled",
                "order",
                "initial_stock",
            ]);
            expect(movements[0]).toMatchObject({
                quantity_change: 3,
                reference_id: order.id,
            });
        });

        test("keeps the line items intact for the record", () => {
            const order = placeOrder(db, {
                customerName: null,
                lines: [{ productId: teeId, quantity: 3 }],
            });

            expect(cancelOrder(db, order.id).items).toHaveLength(1);
        });

        test("cannot be applied twice", () => {
            const order = placeOrder(db, {
                customerName: null,
                lines: [{ productId: teeId, quantity: 3 }],
            });
            cancelOrder(db, order.id);

            expect(() => cancelOrder(db, order.id)).toThrow(/already cancelled/i);
            // Stock must not have been credited a second time.
            expect(getProductById(db, teeId)?.stock_quantity).toBe(50);
        });

        test("throws a 404 for an order that does not exist", () => {
            try {
                cancelOrder(db, 999);
                expect.unreachable("should have thrown");
            } catch (err) {
                expect(err).toBeInstanceOf(AppError);
                expect((err as AppError).status).toBe(404);
            }
        });

        test("still cancels correctly when a product was archived after ordering", () => {
            const order = placeOrder(db, {
                customerName: null,
                lines: [{ productId: teeId, quantity: 3 }],
            });
            archiveProduct(db, teeId);

            expect(() => cancelOrder(db, order.id)).not.toThrow();
            expect(getProductById(db, teeId)?.stock_quantity).toBe(50);
        });
    });

    describe("listOrders after activity", () => {
        test("summarises placed orders", () => {
            placeOrder(db, { customerName: "Ada", lines: [{ productId: teeId, quantity: 2 }] });
            placeOrder(db, { customerName: "Grace", lines: [{ productId: mugId, quantity: 1 }] });

            const summaries = listOrders(db);

            expect(summaries).toHaveLength(2);
            expect(summaries.map((o) => o.customer_name)).toEqual(["Grace", "Ada"]);
        });
    });
});

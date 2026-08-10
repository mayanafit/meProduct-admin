import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import request from "supertest";
import * as cheerio from "cheerio";
import { buildApp } from "../../src/app.js";
import { placeOrder } from "../../src/services/order.js";
import { listOrders, getOrderById } from "../../src/repositories/order.js";
import { getProductById, archiveProduct } from "../../src/repositories/product.js";
import { createTestDb, seedTestProducts } from "../helpers/testDb.js";

function $of(html: string): cheerio.CheerioAPI {
    return cheerio.load(html);
}

describe("order routes", () => {
    let db: DB;
    /** Classic Tee, 50 @ 19.99 */
    let teeId: number;
    /** Ceramic Mug, 10 @ 9.99 */
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

    describe("GET /orders", () => {
        test("renders a row per order with its customer and total", async () => {
            placeOrder(db, { customerName: "Ada", lines: [{ productId: teeId, quantity: 2 }] });

            const res = await request(buildApp(db)).get("/admin/orders");
            const $ = $of(res.text);

            expect(res.status).toBe(200);
            expect($("[data-testid='order-row']")).toHaveLength(1);
            expect($("[data-testid='order-row']").text()).toContain("Ada");
            expect($("[data-testid='order-row']").text()).toContain("39.98");
        });

        test("shows the order status", async () => {
            placeOrder(db, { customerName: "Ada", lines: [{ productId: teeId, quantity: 1 }] });

            const res = await request(buildApp(db)).get("/admin/orders");

            expect($of(res.text)("[data-testid='order-row']").text()).toMatch(/pending/i);
        });

        test("shows an empty state when there are no orders", async () => {
            const res = await request(buildApp(db)).get("/admin/orders");

            expect($of(res.text)("[data-testid='order-row']")).toHaveLength(0);
            expect(res.text).toMatch(/no orders/i);
        });
    });

    describe("GET /orders/new", () => {
        test("renders a quantity input for each active product", async () => {
            const res = await request(buildApp(db)).get("/admin/orders/new");
            const $ = $of(res.text);

            expect(res.status).toBe(200);
            expect($(`form [name='quantity_${teeId}']`)).toHaveLength(1);
            expect($(`form [name='quantity_${mugId}']`)).toHaveLength(1);
        });

        test("shows how much stock each product has left", async () => {
            const res = await request(buildApp(db)).get("/admin/orders/new");

            expect($of(res.text)("[data-testid='orderable-row']").text()).toContain("50");
        });

        test("omits archived products from the picker", async () => {
            archiveProduct(db, teeId);

            const res = await request(buildApp(db)).get("/admin/orders/new");
            const $ = $of(res.text);

            expect($(`form [name='quantity_${teeId}']`)).toHaveLength(0);
            expect($("[data-testid='orderable-row']")).toHaveLength(2);
        });
    });

    describe("POST /orders", () => {
        test("places the order and redirects to it", async () => {
            const res = await request(buildApp(db))
                .post("/admin/orders")
                .type("form")
                .send({ customer_name: "Ada Lovelace", [`quantity_${teeId}`]: "2" });

            const [order] = listOrders(db);
            expect(res.status).toBe(302);
            expect(res.headers["location"]).toBe(`/admin/orders/${order!.id}`);
            expect(order).toMatchObject({ customer_name: "Ada Lovelace", item_count: 1 });
        });

        test("decrements stock and records the movement", async () => {
            await request(buildApp(db))
                .post("/admin/orders")
                .type("form")
                .send({ customer_name: "Ada", [`quantity_${teeId}`]: "3" });

            expect(getProductById(db, teeId)?.stock_quantity).toBe(47);
        });

        test("ignores products left blank or at zero", async () => {
            await request(buildApp(db)).post("/admin/orders").type("form").send({
                customer_name: "Ada",
                [`quantity_${teeId}`]: "2",
                [`quantity_${mugId}`]: "",
            });

            expect(listOrders(db)[0]).toMatchObject({ item_count: 1 });
            expect(getProductById(db, mugId)?.stock_quantity).toBe(10);
        });

        test("accepts several products in one order", async () => {
            await request(buildApp(db)).post("/admin/orders").type("form").send({
                customer_name: "Ada",
                [`quantity_${teeId}`]: "2",
                [`quantity_${mugId}`]: "1",
            });

            expect(listOrders(db)[0]).toMatchObject({ item_count: 2 });
        });

        test("re-renders the form with an error when nothing was selected", async () => {
            const res = await request(buildApp(db))
                .post("/admin/orders")
                .type("form")
                .send({ customer_name: "Ada" });

            expect(res.status).toBe(400);
            expect($of(res.text)("[role='alert']").text()).toMatch(/at least one/i);
            expect(listOrders(db)).toHaveLength(0);
        });

        test("re-renders with the stock error and creates nothing", async () => {
            const res = await request(buildApp(db))
                .post("/admin/orders")
                .type("form")
                .send({ customer_name: "Ada", [`quantity_${mugId}`]: "99" });
            const $ = $of(res.text);

            expect(res.status).toBe(400);
            expect($("[role='alert']").text()).toMatch(/Ceramic Mug.*only 10/i);
            expect($("form")).toHaveLength(1);
            expect(listOrders(db)).toHaveLength(0);
            expect(getProductById(db, mugId)?.stock_quantity).toBe(10);
        });

        test("leaves stock untouched when a later line fails", async () => {
            await request(buildApp(db)).post("/admin/orders").type("form").send({
                customer_name: "Ada",
                [`quantity_${teeId}`]: "2",
                [`quantity_${mugId}`]: "99",
            });

            expect(getProductById(db, teeId)?.stock_quantity).toBe(50);
            expect(listOrders(db)).toHaveLength(0);
        });
    });

    describe("GET /orders/:id", () => {
        test("shows the line items and total", async () => {
            const order = placeOrder(db, {
                customerName: "Ada",
                lines: [
                    { productId: teeId, quantity: 2 },
                    { productId: mugId, quantity: 1 },
                ],
            });

            const res = await request(buildApp(db)).get(`/admin/orders/${order.id}`);
            const $ = $of(res.text);

            expect(res.status).toBe(200);
            expect($("[data-testid='order-item-row']")).toHaveLength(2);
            expect($("[data-testid='order-item-row']").text()).toContain("Classic Tee");
            expect($("[data-testid='order-total']").text()).toContain("49.97");
        });

        test("offers a cancel action for a pending order", async () => {
            const order = placeOrder(db, {
                customerName: "Ada",
                lines: [{ productId: teeId, quantity: 1 }],
            });

            const res = await request(buildApp(db)).get(`/admin/orders/${order.id}`);
            const $ = $of(res.text);

            expect($(`form[action='/admin/orders/${order.id}/cancel']`)).toHaveLength(1);
        });

        test("404s for an order that does not exist", async () => {
            const res = await request(buildApp(db)).get("/admin/orders/999");

            expect(res.status).toBe(404);
        });

        test("404s for a non-numeric id rather than crashing", async () => {
            const res = await request(buildApp(db)).get("/admin/orders/banana");

            expect(res.status).toBe(404);
        });

        test("offers a breadcrumb back to the order list", async () => {
            const order = placeOrder(db, {
                customerName: "Ada",
                lines: [{ productId: teeId, quantity: 1 }],
            });

            const res = await request(buildApp(db)).get(`/admin/orders/${order.id}`);
            const $ = $of(res.text);
            const crumb = $("nav[aria-label='Breadcrumb']");

            expect(crumb).toHaveLength(1);
            expect(crumb.find("a[href='/admin/orders']")).toHaveLength(1);
            expect(crumb.text()).toContain(`#${order.id}`);
        });
    });

    describe("GET /orders/new", () => {
        test("offers a breadcrumb back to the order list", async () => {
            const res = await request(buildApp(db)).get("/admin/orders/new");
            const $ = $of(res.text);

            expect($("nav[aria-label='Breadcrumb'] a[href='/admin/orders']")).toHaveLength(1);
        });
    });

    describe("POST /orders/:id/status", () => {
        async function place(app: ReturnType<typeof buildApp>): Promise<number> {
            await request(app)
                .post("/admin/orders")
                .type("form")
                .send({ customer_name: "Ada", [`quantity_${teeId}`]: "2" });
            return listOrders(db)[0]!.id;
        }

        test("marks an order paid and redirects back to it", async () => {
            const app = buildApp(db);
            const id = await place(app);

            const res = await request(app)
                .post(`/admin/orders/${id}/status`)
                .type("form")
                .send({ status: "paid" });

            expect(res.status).toBe(302);
            expect(res.headers["location"]).toBe(`/admin/orders/${id}`);
            expect(getOrderById(db, id)?.status).toBe("paid");
        });

        test("the badge on the detail page reflects the new status", async () => {
            const app = buildApp(db);
            const id = await place(app);
            await request(app).post(`/admin/orders/${id}/status`).type("form").send({ status: "shipped" });

            const res = await request(app).get(`/admin/orders/${id}`);

            expect($of(res.text)("[data-testid='order-status']").text()).toMatch(/shipped/i);
        });

        test("offers paid and shipped actions while pending", async () => {
            const app = buildApp(db);
            const id = await place(app);

            const $ = $of((await request(app).get(`/admin/orders/${id}`)).text);
            const actions = $(`form[action='/admin/orders/${id}/status'] [name='status']`)
                .map((_, el) => $(el).attr("value"))
                .get();

            expect(actions).toEqual(expect.arrayContaining(["paid", "shipped"]));
        });

        test("drops the paid action once paid", async () => {
            const app = buildApp(db);
            const id = await place(app);
            await request(app).post(`/admin/orders/${id}/status`).type("form").send({ status: "paid" });

            const $ = $of((await request(app).get(`/admin/orders/${id}`)).text);
            const actions = $(`form[action='/admin/orders/${id}/status'] [name='status']`)
                .map((_, el) => $(el).attr("value"))
                .get();

            expect(actions).toEqual(["shipped"]);
        });

        test("offers no actions at all once shipped", async () => {
            const app = buildApp(db);
            const id = await place(app);
            await request(app).post(`/admin/orders/${id}/status`).type("form").send({ status: "shipped" });

            const $ = $of((await request(app).get(`/admin/orders/${id}`)).text);

            expect($(`form[action='/admin/orders/${id}/status']`)).toHaveLength(0);
            expect($(`form[action='/admin/orders/${id}/cancel']`)).toHaveLength(0);
        });

        test("shows an illegal transition inline as a 409", async () => {
            const app = buildApp(db);
            const id = await place(app);
            await request(app).post(`/admin/orders/${id}/status`).type("form").send({ status: "shipped" });

            const res = await request(app)
                .post(`/admin/orders/${id}/status`)
                .type("form")
                .send({ status: "paid" });

            expect(res.status).toBe(409);
            expect($of(res.text)("[role='alert']").text()).toMatch(/cannot be marked paid/i);
            expect(getOrderById(db, id)?.status).toBe("shipped");
        });

        test("rejects an unknown status with a readable message", async () => {
            const app = buildApp(db);
            const id = await place(app);

            const res = await request(app)
                .post(`/admin/orders/${id}/status`)
                .type("form")
                .send({ status: "teleported" });

            expect(res.status).toBe(400);
            expect($of(res.text)("[role='alert']").text()).toMatch(/not a valid order status/i);
        });

        test("404s for an order that does not exist", async () => {
            const res = await request(buildApp(db))
                .post("/admin/orders/999/status")
                .type("form")
                .send({ status: "paid" });

            expect(res.status).toBe(404);
        });

        test("changing status leaves stock alone", async () => {
            const app = buildApp(db);
            const id = await place(app);

            await request(app).post(`/admin/orders/${id}/status`).type("form").send({ status: "paid" });

            expect(getProductById(db, teeId)?.stock_quantity).toBe(48);
        });
    });

    describe("POST /orders/:id/cancel", () => {
        test("cancels the order, restores stock and redirects", async () => {
            const order = placeOrder(db, {
                customerName: "Ada",
                lines: [{ productId: teeId, quantity: 3 }],
            });

            const res = await request(buildApp(db)).post(`/admin/orders/${order.id}/cancel`);

            expect(res.status).toBe(302);
            expect(res.headers["location"]).toBe(`/admin/orders/${order.id}`);
            expect(getOrderById(db, order.id)?.status).toBe("cancelled");
            expect(getProductById(db, teeId)?.stock_quantity).toBe(50);
        });

        test("hides the cancel action once cancelled", async () => {
            const order = placeOrder(db, {
                customerName: "Ada",
                lines: [{ productId: teeId, quantity: 1 }],
            });
            const app = buildApp(db);
            await request(app).post(`/admin/orders/${order.id}/cancel`);

            const res = await request(app).get(`/admin/orders/${order.id}`);

            expect($of(res.text)(`form[action='/admin/orders/${order.id}/cancel']`)).toHaveLength(0);
        });

        test("shows the error inline on a second cancel, without crediting stock twice", async () => {
            const order = placeOrder(db, {
                customerName: "Ada",
                lines: [{ productId: teeId, quantity: 3 }],
            });
            const app = buildApp(db);
            await request(app).post(`/admin/orders/${order.id}/cancel`);

            const res = await request(app).post(`/admin/orders/${order.id}/cancel`);

            expect(res.status).toBe(409);
            expect($of(res.text)("[role='alert']").text()).toMatch(/already cancelled/i);
            expect(getProductById(db, teeId)?.stock_quantity).toBe(50);
        });

        test("404s for an order that does not exist", async () => {
            const res = await request(buildApp(db)).post("/admin/orders/999/cancel");

            expect(res.status).toBe(404);
        });
    });
});

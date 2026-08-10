import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import type { Express } from "express";
import request from "supertest";
import * as cheerio from "cheerio";
import { buildApp } from "../../src/app.js";
import { listOrders, getOrderWithItems } from "../../src/repositories/order.js";
import { getProductById, archiveProduct, adjustStock } from "../../src/repositories/product.js";
import { listMovementsForProduct } from "../../src/repositories/stockMovement.js";
import { createTestDb, seedTestProducts } from "../helpers/testDb.js";

function $of(html: string): cheerio.CheerioAPI {
    return cheerio.load(html);
}

describe("storefront", () => {
    let db: DB;
    let app: Express;
    /** Classic Tee, 50 @ 19.99 */
    let teeId: number;
    /** Ceramic Mug, 10 @ 9.99 */
    let mugId: number;
    /** Sold Out Hat, 0 in stock */
    let hatId: number;

    /** A cookie-preserving client — the cart lives in the session. */
    function shopper() {
        return request.agent(app);
    }

    beforeEach(() => {
        db = createTestDb();
        app = buildApp(db);
        const ids = seedTestProducts(db);
        teeId = ids[0]!;
        mugId = ids[1]!;
        hatId = ids[2]!;
    });

    afterEach(() => {
        db.close();
    });

    describe("GET /", () => {
        test("lists the catalogue", async () => {
            const res = await request(app).get("/");

            expect(res.status).toBe(200);
            expect($of(res.text)("[data-testid='shop-product-card']")).toHaveLength(3);
        });

        test("shows names and prices", async () => {
            const $ = $of((await request(app).get("/")).text);
            const card = $(`[data-testid='shop-product-card'][data-product-id='${teeId}']`);

            expect(card.text()).toContain("Classic Tee");
            expect(card.text()).toContain("19.99");
        });

        test("hides archived products from customers", async () => {
            archiveProduct(db, teeId);

            const $ = $of((await request(app).get("/")).text);

            expect($("[data-testid='shop-product-card']")).toHaveLength(2);
            expect($.text()).not.toContain("Classic Tee");
        });

        test("does not show the admin navigation", async () => {
            const $ = $of((await request(app).get("/")).text);

            expect($("a[href='/admin/products']")).toHaveLength(0);
            expect($("a[href='/cart']").length).toBeGreaterThan(0);
        });

        test("marks an out-of-stock product as unavailable", async () => {
            const $ = $of((await request(app).get("/")).text);
            const card = $(`[data-testid='shop-product-card'][data-product-id='${hatId}']`);

            expect(card.text()).toMatch(/out of stock/i);
            expect(card.find("button[disabled]")).toHaveLength(1);
        });
    });

    describe("GET /products/:id", () => {
        test("shows the product with an add-to-cart form", async () => {
            const res = await request(app).get(`/products/${teeId}`);
            const $ = $of(res.text);

            expect(res.status).toBe(200);
            expect($("h1").text()).toContain("Classic Tee");
            expect($("form[action='/cart'] [name='product_id']").attr("value")).toBe(String(teeId));
        });

        test("404s an archived product", async () => {
            archiveProduct(db, teeId);

            expect((await request(app).get(`/products/${teeId}`)).status).toBe(404);
        });

        test("404s an unknown id", async () => {
            expect((await request(app).get("/products/9999")).status).toBe(404);
        });

        test("404s a non-numeric id", async () => {
            expect((await request(app).get("/products/banana")).status).toBe(404);
        });
    });

    describe("cart", () => {
        test("starts empty", async () => {
            const res = await shopper().get("/cart");

            expect($of(res.text)("[data-testid='cart-row']")).toHaveLength(0);
            expect(res.text).toMatch(/your cart is empty/i);
        });

        test("adding a product redirects to the cart and shows the line", async () => {
            const agent = shopper();

            const added = await agent
                .post("/cart")
                .type("form")
                .send({ product_id: String(teeId), quantity: "2" });
            expect(added.status).toBe(302);
            expect(added.headers["location"]).toBe("/cart");

            const $ = $of((await agent.get("/cart")).text);
            expect($("[data-testid='cart-row']")).toHaveLength(1);
            expect($("[data-testid='cart-total']").text()).toContain("39.98");
        });

        test("the cart is per-visitor, not global", async () => {
            const ada = shopper();
            await ada.post("/cart").type("form").send({ product_id: String(teeId), quantity: "2" });

            const stranger = shopper();

            expect($of((await stranger.get("/cart")).text)("[data-testid='cart-row']")).toHaveLength(0);
        });

        test("the nav badge counts units", async () => {
            const agent = shopper();
            await agent.post("/cart").type("form").send({ product_id: String(teeId), quantity: "2" });
            await agent.post("/cart").type("form").send({ product_id: String(mugId), quantity: "3" });

            const $ = $of((await agent.get("/")).text);

            expect($("[data-testid='cart-count']").text().trim()).toBe("5");
        });

        test("adding the same product twice accumulates", async () => {
            const agent = shopper();
            await agent.post("/cart").type("form").send({ product_id: String(teeId), quantity: "2" });
            await agent.post("/cart").type("form").send({ product_id: String(teeId), quantity: "3" });

            const $ = $of((await agent.get("/cart")).text);

            expect($("[data-testid='cart-row']")).toHaveLength(1);
            expect($("[data-testid='cart-row'] [name='quantity']").attr("value")).toBe("5");
        });

        test("updating the quantity replaces it", async () => {
            const agent = shopper();
            await agent.post("/cart").type("form").send({ product_id: String(teeId), quantity: "2" });

            await agent.post(`/cart/${teeId}`).type("form").send({ quantity: "7" });

            const $ = $of((await agent.get("/cart")).text);
            expect($("[data-testid='cart-row'] [name='quantity']").attr("value")).toBe("7");
        });

        test("setting a quantity to zero removes the line", async () => {
            const agent = shopper();
            await agent.post("/cart").type("form").send({ product_id: String(teeId), quantity: "2" });

            await agent.post(`/cart/${teeId}`).type("form").send({ quantity: "0" });

            expect($of((await agent.get("/cart")).text)("[data-testid='cart-row']")).toHaveLength(0);
        });

        test("refuses to add an archived product", async () => {
            archiveProduct(db, teeId);

            const res = await shopper()
                .post("/cart")
                .type("form")
                .send({ product_id: String(teeId), quantity: "1" });

            expect(res.status).toBe(404);
        });

        test("warns when stock drops below what's in the cart", async () => {
            const agent = shopper();
            await agent.post("/cart").type("form").send({ product_id: String(mugId), quantity: "8" });

            adjustStock(db, mugId, -7); // 3 left, 8 in the cart

            const $ = $of((await agent.get("/cart")).text);
            expect($("[data-testid='cart-issue']").text()).toMatch(/only 3/i);
        });
    });

    describe("checkout", () => {
        async function withCart(quantity = 2) {
            const agent = shopper();
            await agent
                .post("/cart")
                .type("form")
                .send({ product_id: String(teeId), quantity: String(quantity) });
            return agent;
        }

        test("redirects to the cart when there is nothing to buy", async () => {
            const res = await shopper().get("/checkout");

            expect(res.status).toBe(302);
            expect(res.headers["location"]).toBe("/cart");
        });

        test("shows an order summary", async () => {
            const agent = await withCart();

            const $ = $of((await agent.get("/checkout")).text);

            expect($("[data-testid='summary-row']")).toHaveLength(1);
            expect($("[data-testid='checkout-total']").text()).toContain("39.98");
        });

        test("places the order and redirects to its reference", async () => {
            const agent = await withCart(3);

            const res = await agent
                .post("/checkout")
                .type("form")
                .send({ customer_name: "Ada Lovelace", customer_email: "ada@example.com" });

            const [order] = listOrders(db);
            expect(res.status).toBe(302);
            expect(res.headers["location"]).toBe(`/order/${order!.reference}`);
            expect(order).toMatchObject({
                customer_name: "Ada Lovelace",
                customer_email: "ada@example.com",
                status: "pending",
            });
        });

        test("decrements stock and logs the movement", async () => {
            const agent = await withCart(3);

            await agent
                .post("/checkout")
                .type("form")
                .send({ customer_name: "Ada", customer_email: "ada@example.com" });

            expect(getProductById(db, teeId)?.stock_quantity).toBe(47);
            expect(listMovementsForProduct(db, teeId)[0]).toMatchObject({
                quantity_change: -3,
                reason: "order",
            });
        });

        test("empties the cart afterwards", async () => {
            const agent = await withCart();
            await agent
                .post("/checkout")
                .type("form")
                .send({ customer_name: "Ada", customer_email: "ada@example.com" });

            expect($of((await agent.get("/cart")).text)("[data-testid='cart-row']")).toHaveLength(0);
        });

        test.each([
            ["a missing name", { customer_name: "", customer_email: "a@b.com" }, /enter your name/i],
            ["a missing email", { customer_name: "Ada", customer_email: "" }, /enter your email/i],
            ["a malformed email", { customer_name: "Ada", customer_email: "nope" }, /valid email/i],
        ])("rejects %s inline and creates nothing", async (_label, body, expected) => {
            const agent = await withCart();

            const res = await agent.post("/checkout").type("form").send(body);

            expect(res.status).toBe(400);
            expect($of(res.text)("[role='alert']").text()).toMatch(expected);
            expect(listOrders(db)).toHaveLength(0);
            expect(getProductById(db, teeId)?.stock_quantity).toBe(50);
        });

        test("keeps the cart when checkout is rejected", async () => {
            const agent = await withCart();
            await agent.post("/checkout").type("form").send({ customer_name: "", customer_email: "" });

            expect($of((await agent.get("/cart")).text)("[data-testid='cart-row']")).toHaveLength(1);
        });

        test("rejects checkout when stock ran out first", async () => {
            const agent = await withCart(5);
            adjustStock(db, teeId, -48); // 2 left, 5 in the cart

            const res = await agent
                .post("/checkout")
                .type("form")
                .send({ customer_name: "Ada", customer_email: "ada@example.com" });

            expect(res.status).toBe(400);
            expect($of(res.text)("[role='alert']").text()).toMatch(/only 2/i);
            expect(listOrders(db)).toHaveLength(0);
        });
    });

    describe("GET /order/:reference", () => {
        async function placeViaShop() {
            const agent = shopper();
            await agent.post("/cart").type("form").send({ product_id: String(teeId), quantity: "2" });
            await agent
                .post("/checkout")
                .type("form")
                .send({ customer_name: "Ada", customer_email: "ada@example.com" });
            return listOrders(db)[0]!;
        }

        test("shows the order's items and total", async () => {
            const order = await placeViaShop();

            const res = await request(app).get(`/order/${order.reference}`);
            const $ = $of(res.text);

            expect(res.status).toBe(200);
            expect($("[data-testid='confirmation-row']")).toHaveLength(1);
            expect($("[data-testid='confirmation-total']").text()).toContain("39.98");
            expect($("[data-testid='order-reference']").text()).toContain(order.reference);
        });

        test("404s an unknown reference", async () => {
            expect((await request(app).get("/order/not-a-real-reference")).status).toBe(404);
        });

        test("is not reachable by guessing the integer id", async () => {
            const order = await placeViaShop();

            // The whole point of the reference: /order/1 must not resolve.
            expect((await request(app).get(`/order/${order.id}`)).status).toBe(404);
        });
    });

    describe("connected to the admin dashboard", () => {
        test("a storefront order appears in the admin order list", async () => {
            const agent = shopper();
            await agent.post("/cart").type("form").send({ product_id: String(teeId), quantity: "2" });
            await agent
                .post("/checkout")
                .type("form")
                .send({ customer_name: "Ada Lovelace", customer_email: "ada@example.com" });

            const $ = $of((await request(app).get("/admin/orders")).text);

            expect($("[data-testid='order-row']")).toHaveLength(1);
            expect($("[data-testid='order-row']").text()).toContain("Ada Lovelace");
        });

        test("and on the dashboard's recent orders panel", async () => {
            const agent = shopper();
            await agent.post("/cart").type("form").send({ product_id: String(mugId), quantity: "1" });
            await agent
                .post("/checkout")
                .type("form")
                .send({ customer_name: "Grace", customer_email: "grace@example.com" });

            const $ = $of((await request(app).get("/admin")).text);

            expect($("[data-testid='recent-order-row']").text()).toContain("Grace");
            expect($("[data-testid='stat-orders']").text().trim()).toBe("1");
        });

        test("the admin can open it and see the line items", async () => {
            const agent = shopper();
            await agent.post("/cart").type("form").send({ product_id: String(teeId), quantity: "2" });
            await agent
                .post("/checkout")
                .type("form")
                .send({ customer_name: "Ada", customer_email: "ada@example.com" });

            const order = listOrders(db)[0]!;
            const $ = $of((await request(app).get(`/admin/orders/${order.id}`)).text);

            expect($("[data-testid='order-item-row']")).toHaveLength(1);
            expect($("[data-testid='order-item-row']").text()).toContain("Classic Tee");
        });

        test("the admin can cancel it, restoring stock", async () => {
            const agent = shopper();
            await agent.post("/cart").type("form").send({ product_id: String(teeId), quantity: "4" });
            await agent
                .post("/checkout")
                .type("form")
                .send({ customer_name: "Ada", customer_email: "ada@example.com" });

            const order = listOrders(db)[0]!;
            expect(getProductById(db, teeId)?.stock_quantity).toBe(46);

            await request(app).post(`/admin/orders/${order.id}/cancel`);

            expect(getProductById(db, teeId)?.stock_quantity).toBe(50);
            expect(getOrderWithItems(db, order.id)?.status).toBe("cancelled");
        });
    });
});

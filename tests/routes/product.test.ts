import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import request from "supertest";
import * as cheerio from "cheerio";
import { buildApp } from "../../src/app.js";
import { listProducts, getProductById } from "../../src/repositories/product.js";
import { listMovementsForProduct } from "../../src/repositories/stockMovement.js";
import { createTestDb, seedTestProducts } from "../helpers/testDb.js";

function $of(html: string): cheerio.CheerioAPI {
    return cheerio.load(html);
}

describe("product routes", () => {
    let db: DB;
    let teeId: number;

    beforeEach(() => {
        db = createTestDb();
        teeId = seedTestProducts(db)[0]!;
    });

    afterEach(() => {
        db.close();
    });

    describe("GET /products", () => {
        test("renders a row per active product", async () => {
            const res = await request(buildApp(db)).get("/admin/products");
            const $ = $of(res.text);

            expect(res.status).toBe(200);
            expect($("[data-testid='product-row']")).toHaveLength(3);
        });

        test("shows each product's name, sku and stock", async () => {
            const res = await request(buildApp(db)).get("/admin/products");
            const $ = $of(res.text);
            const row = $(`[data-testid='product-row'][data-product-id='${teeId}']`);

            expect(row.text()).toContain("Classic Tee");
            expect(row.text()).toContain("TEE-001");
            expect(row.text()).toContain("50");
        });

        test("formats price as currency", async () => {
            const res = await request(buildApp(db)).get("/admin/products");
            const $ = $of(res.text);

            expect($(`[data-testid='product-row'][data-product-id='${teeId}']`).text()).toContain(
                "19.99"
            );
        });

        test("omits archived products", async () => {
            await request(buildApp(db)).post(`/admin/products/${teeId}`).type("form").send({
                _method: "DELETE",
            });

            const res = await request(buildApp(db)).get("/admin/products");

            expect($of(res.text)("[data-testid='product-row']")).toHaveLength(2);
        });

        test("shows an empty state when there is nothing to list", async () => {
            const empty = createTestDb();
            const res = await request(buildApp(empty)).get("/admin/products");

            expect($of(res.text)("[data-testid='product-row']")).toHaveLength(0);
            expect(res.text).toMatch(/no products/i);
            empty.close();
        });
    });

    describe("GET /products/new", () => {
        test("renders a form posting to /products", async () => {
            const res = await request(buildApp(db)).get("/admin/products/new");
            const $ = $of(res.text);
            const form = $("form[data-testid='product-form']");

            expect(res.status).toBe(200);
            expect(form.attr("action")).toBe("/admin/products");
            expect(form.attr("method")?.toLowerCase()).toBe("post");
        });

        test("offers a breadcrumb back to the product list", async () => {
            const res = await request(buildApp(db)).get("/admin/products/new");
            const $ = $of(res.text);

            expect($("nav[aria-label='Breadcrumb'] a[href='/admin/products']")).toHaveLength(1);
        });

        test("exposes every field the create needs", async () => {
            const res = await request(buildApp(db)).get("/admin/products/new");
            const $ = $of(res.text);

            for (const field of ["name", "sku", "price", "description", "stock_quantity"]) {
                expect($(`form [name='${field}']`), `missing field ${field}`).toHaveLength(1);
            }
        });
    });

    describe("POST /products", () => {
        test("creates the product and redirects to the list", async () => {
            const res = await request(buildApp(db)).post("/admin/products").type("form").send({
                name: "Enamel Pin",
                sku: "PIN-001",
                price: "4.50",
                description: "Small pin.",
                stock_quantity: "25",
            });

            expect(res.status).toBe(302);
            expect(res.headers["location"]).toBe("/admin/products");

            const created = listProducts(db).find((p) => p.sku === "PIN-001");
            expect(created).toMatchObject({ name: "Enamel Pin", price: 4.5, stock_quantity: 25 });
        });

        test("the new product then appears on the list page", async () => {
            const app = buildApp(db);
            await request(app).post("/admin/products").type("form").send({
                name: "Enamel Pin",
                sku: "PIN-001",
                price: "4.50",
                stock_quantity: "25",
            });

            const res = await request(app).get("/admin/products");

            expect(res.text).toContain("Enamel Pin");
            expect($of(res.text)("[data-testid='product-row']")).toHaveLength(4);
        });

        test("records the opening stock movement", async () => {
            await request(buildApp(db)).post("/admin/products").type("form").send({
                name: "Enamel Pin",
                sku: "PIN-001",
                price: "4.50",
                stock_quantity: "25",
            });

            const created = listProducts(db).find((p) => p.sku === "PIN-001")!;
            expect(listMovementsForProduct(db, created.id)).toMatchObject([
                { reason: "initial_stock", quantity_change: 25 },
            ]);
        });

        test("re-renders the form with the error when the price is invalid", async () => {
            const res = await request(buildApp(db)).post("/admin/products").type("form").send({
                name: "Bad Product",
                sku: "BAD-001",
                price: "0",
                stock_quantity: "5",
            });
            const $ = $of(res.text);

            expect(res.status).toBe(400);
            expect($("[role='alert']").text()).toMatch(/price must be greater than 0/i);
            expect($("form[data-testid='product-form']")).toHaveLength(1);
        });

        test("keeps what the user typed when re-rendering after an error", async () => {
            const res = await request(buildApp(db)).post("/admin/products").type("form").send({
                name: "Bad Product",
                sku: "BAD-001",
                price: "0",
                stock_quantity: "5",
            });
            const $ = $of(res.text);

            expect($("form [name='name']").attr("value")).toBe("Bad Product");
            expect($("form [name='sku']").attr("value")).toBe("BAD-001");
        });

        test("creates nothing when the submission is rejected", async () => {
            await request(buildApp(db)).post("/admin/products").type("form").send({
                name: "Bad Product",
                sku: "BAD-001",
                price: "0",
                stock_quantity: "5",
            });

            expect(listProducts(db)).toHaveLength(3);
        });

        test("reports a duplicate sku inline rather than as a crash", async () => {
            const res = await request(buildApp(db)).post("/admin/products").type("form").send({
                name: "Copycat",
                sku: "TEE-001",
                price: "5",
                stock_quantity: "1",
            });

            expect(res.status).toBe(409);
            expect($of(res.text)("[role='alert']").text()).toMatch(/already in use/i);
        });

        test("rejects a non-numeric price", async () => {
            const res = await request(buildApp(db)).post("/admin/products").type("form").send({
                name: "Weird",
                price: "not-a-number",
                stock_quantity: "1",
            });

            expect(res.status).toBe(400);
            expect($of(res.text)("[role='alert']").text()).toMatch(/price/i);
        });
    });

    describe("GET /products/:id", () => {
        test("shows the product and its stock history", async () => {
            const res = await request(buildApp(db)).get(`/admin/products/${teeId}`);
            const $ = $of(res.text);

            expect(res.status).toBe(200);
            expect($("h1").text()).toContain("Classic Tee");
            expect($("[data-testid='movement-row']")).toHaveLength(1);
            expect($("[data-testid='movement-row']").text()).toMatch(/initial stock/i);
        });

        test("404s for a product that does not exist", async () => {
            const res = await request(buildApp(db)).get("/admin/products/999");

            expect(res.status).toBe(404);
            expect(res.text).toMatch(/does not exist/i);
        });

        test("404s for a non-numeric id rather than crashing", async () => {
            const res = await request(buildApp(db)).get("/admin/products/banana");

            expect(res.status).toBe(404);
        });

        test("offers a breadcrumb back to the product list", async () => {
            const res = await request(buildApp(db)).get(`/admin/products/${teeId}`);
            const $ = $of(res.text);
            const crumb = $("nav[aria-label='Breadcrumb']");

            expect(crumb).toHaveLength(1);
            expect(crumb.find("a[href='/admin/products']")).toHaveLength(1);
            expect(crumb.text()).toContain("Classic Tee");
        });
    });

    describe("GET /products/:id/edit", () => {
        test("renders a form pre-filled with the current values", async () => {
            const res = await request(buildApp(db)).get(`/admin/products/${teeId}/edit`);
            const $ = $of(res.text);

            expect(res.status).toBe(200);
            expect($("form [name='name']").attr("value")).toBe("Classic Tee");
            expect($("form [name='price']").attr("value")).toBe("19.99");
        });

        test("offers a breadcrumb back to the product and the list", async () => {
            const res = await request(buildApp(db)).get(`/admin/products/${teeId}/edit`);
            const $ = $of(res.text);
            const crumb = $("nav[aria-label='Breadcrumb']");

            expect(crumb.find("a[href='/admin/products']")).toHaveLength(1);
            expect(crumb.find(`a[href='/admin/products/${teeId}']`)).toHaveLength(1);
        });

        test("carries the _method override so the form can issue a PUT", async () => {
            const res = await request(buildApp(db)).get(`/admin/products/${teeId}/edit`);
            const $ = $of(res.text);

            expect($("form [name='_method']").attr("value")).toBe("PUT");
            expect($("form[data-testid='product-form']").attr("action")).toBe(`/admin/products/${teeId}`);
        });
    });

    describe("PUT /products/:id", () => {
        test("applies the update and redirects to the product", async () => {
            const res = await request(buildApp(db))
                .post(`/admin/products/${teeId}`)
                .type("form")
                .send({ _method: "PUT", name: "Renamed Tee", price: "24.50" });

            expect(res.status).toBe(302);
            expect(res.headers["location"]).toBe(`/admin/products/${teeId}`);
            expect(getProductById(db, teeId)).toMatchObject({
                name: "Renamed Tee",
                price: 24.5,
            });
        });

        test("re-renders the edit form with the error on invalid input", async () => {
            const res = await request(buildApp(db))
                .post(`/admin/products/${teeId}`)
                .type("form")
                .send({ _method: "PUT", name: "", price: "24.50" });

            expect(res.status).toBe(400);
            expect($of(res.text)("[role='alert']").text()).toMatch(/name is required/i);
            expect(getProductById(db, teeId)?.name).toBe("Classic Tee");
        });
    });

    describe("DELETE /products/:id", () => {
        test("archives the product and redirects to the list", async () => {
            const res = await request(buildApp(db))
                .post(`/admin/products/${teeId}`)
                .type("form")
                .send({ _method: "DELETE" });

            expect(res.status).toBe(302);
            expect(res.headers["location"]).toBe("/admin/products");
            expect(getProductById(db, teeId)?.archived_at).not.toBeNull();
        });

        test("404s for a product that does not exist", async () => {
            const res = await request(buildApp(db))
                .post("/admin/products/999")
                .type("form")
                .send({ _method: "DELETE" });

            expect(res.status).toBe(404);
        });
    });

    describe("POST /products/:id/stock", () => {
        test("applies an adjustment and logs it", async () => {
            const res = await request(buildApp(db))
                .post(`/admin/products/${teeId}/stock`)
                .type("form")
                .send({ delta: "12" });

            expect(res.status).toBe(302);
            expect(getProductById(db, teeId)?.stock_quantity).toBe(62);
            expect(listMovementsForProduct(db, teeId)[0]).toMatchObject({
                quantity_change: 12,
                reason: "adjustment",
            });
        });

        test("refuses to take stock negative and says why", async () => {
            const res = await request(buildApp(db))
                .post(`/admin/products/${teeId}/stock`)
                .type("form")
                .send({ delta: "-51" });

            expect(res.status).toBe(400);
            expect($of(res.text)("[role='alert']").text()).toMatch(/only 50 in stock/i);
            expect(getProductById(db, teeId)?.stock_quantity).toBe(50);
        });
    });
});

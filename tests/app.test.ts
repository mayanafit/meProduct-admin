import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { createTestDb, seedTestProducts } from "./helpers/testDb.js";

describe("buildApp", () => {
    let db: DB;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        db.close();
    });

    test("serves an HTML home page", async () => {
        const res = await request(buildApp(db)).get("/");

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/html/);
        expect(res.text).toMatch(/<html/i);
    });

    test("renders a 404 page for an unknown path", async () => {
        const res = await request(buildApp(db)).get("/nope");

        expect(res.status).toBe(404);
        expect(res.headers["content-type"]).toMatch(/html/);
        expect(res.text).toMatch(/not found/i);
    });

    test("reads from the database it was handed, not a file on disk", async () => {
        seedTestProducts(db);

        const res = await request(buildApp(db)).get("/");

        // Proves the injected in-memory DB is the one the app queries: the
        // fixture has exactly 3 products, the real data file has 15.
        expect(res.text).toContain("<strong>3</strong>");
    });
});

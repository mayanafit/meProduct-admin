import { describe, test, expect, vi, afterEach } from "vitest";
import express from "express";
import type { Express } from "express";
import request from "supertest";
import { AppError } from "../../src/errors.js";
import { configureViews } from "../../src/app.js";
import { notFound } from "../../src/middleware/notFound.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";

/**
 * A minimal app carrying only the pieces under test, so these assertions stay
 * independent of how the real routers happen to be wired.
 */
function buildHarness(mount: (app: Express) => void): Express {
    const app = express();
    configureViews(app);
    mount(app);
    app.use(notFound);
    app.use(errorHandler);
    return app;
}

describe("notFound", () => {
    test("renders a 404 page for an unknown path", async () => {
        const app = buildHarness(() => {});

        const res = await request(app).get("/no-such-page");

        expect(res.status).toBe(404);
        expect(res.headers["content-type"]).toMatch(/html/);
        expect(res.text).toMatch(/not found/i);
    });
});

describe("errorHandler", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test("uses the status carried by an AppError", async () => {
        const app = buildHarness((a) => {
            a.get("/missing", () => {
                throw new AppError("Product 999 does not exist", 404);
            });
        });

        const res = await request(app).get("/missing");

        expect(res.status).toBe(404);
        expect(res.text).toContain("Product 999 does not exist");
    });

    test("surfaces a 400 validation message to the user", async () => {
        const app = buildHarness((a) => {
            a.get("/invalid", () => {
                throw new AppError("Price must be greater than 0", 400);
            });
        });

        const res = await request(app).get("/invalid");

        expect(res.status).toBe(400);
        expect(res.text).toContain("Price must be greater than 0");
    });

    test("catches errors thrown from an async handler", async () => {
        const app = buildHarness((a) => {
            a.get("/async-boom", async () => {
                await Promise.resolve();
                throw new AppError("Async failure", 409);
            });
        });

        const res = await request(app).get("/async-boom");

        expect(res.status).toBe(409);
        expect(res.text).toContain("Async failure");
    });

    test("turns an unexpected error into a 500 without leaking its message", async () => {
        // The handler logs unexpected errors; capture that instead of letting
        // a deliberately alarming fake path print into the test output.
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        const app = buildHarness((a) => {
            a.get("/boom", () => {
                throw new Error("SQLITE_CORRUPT: /var/secret/path.sqlite");
            });
        });

        const res = await request(app).get("/boom");

        expect(res.status).toBe(500);
        expect(res.text).not.toContain("/var/secret/path.sqlite");
        expect(res.text).toMatch(/something went wrong/i);

        // Hidden from the user, but it must still reach the server log.
        expect(logged).toHaveBeenCalledOnce();
        expect(logged.mock.calls[0]?.[0]).toMatchObject({
            message: "SQLITE_CORRUPT: /var/secret/path.sqlite",
        });
    });

    test("does not log an AppError, which is an expected outcome", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        const app = buildHarness((a) => {
            a.get("/expected", () => {
                throw new AppError("Out of stock", 400);
            });
        });

        await request(app).get("/expected");

        expect(logged).not.toHaveBeenCalled();
    });
});

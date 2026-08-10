import express from "express";
import type { Express } from "express";
import methodOverride from "method-override";
import session from "express-session";
import path from "node:path";
import type { Database as DB } from "better-sqlite3";
import { config } from "./config/env.js";
import {
    createDashboardRouter,
    createProductRouter,
    createOrderRouter,
    createShopRouter,
} from "./routes/index.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";

/**
 * Views and static assets live at the project root rather than under `src/`
 * because `tsc` only emits `.ts` files — `.ejs` templates would never reach
 * `dist/`, breaking `pnpm start`. Resolving from cwd keeps dev and prod aligned.
 */
const ROOT = process.cwd();

export function configureViews(app: Express): void {
    app.set("view engine", "ejs");
    app.set("views", path.join(ROOT, "views"));
}

/**
 * Builds the application without binding a port, so tests can drive it through
 * supertest with an injected in-memory database.
 */
export function buildApp(db: DB): Express {
    const app = express();

    configureViews(app);

    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    // Lets HTML forms issue PUT/DELETE via a hidden `_method` field. Passing
    // the string form of methodOverride would read `?_method=` from the query
    // string instead of the body, so the override has to be read explicitly.
    // Must come after the body parser, and the field is removed so it never
    // reaches a route as if it were form data.
    app.use(
        // Returning the request's own method means "no override" — the getter
        // is typed as returning a string, so `undefined` isn't an option.
        methodOverride((req) => {
            const body: unknown = req.body;
            if (typeof body !== "object" || body === null) return req.method;

            const record = body as Record<string, unknown>;
            const override = record["_method"];
            if (typeof override !== "string") return req.method;

            delete record["_method"];
            return override;
        })
    );
    app.use(express.static(path.join(ROOT, "public")));

    // Carts live in the session. The default MemoryStore is deliberate: carts
    // are disposable, this is single-process, and nothing here is deployed.
    // It does not survive a restart and grows unbounded under real load.
    app.use(
        session({
            secret: config.SESSION_SECRET,
            resave: false,
            // No cookie is issued until something is actually put in the cart.
            saveUninitialized: false,
            cookie: {
                httpOnly: true,
                sameSite: "lax",
                // No HTTPS in local development.
                secure: false,
                maxAge: 1000 * 60 * 60 * 24 * 7,
            },
        })
    );

    // Customers get the root; the admin lives under /admin. Neither is
    // authenticated — see the note in docs/phase-5-storefront.md.
    app.use("/", createShopRouter(db));
    app.use("/admin", createDashboardRouter(db));
    app.use("/admin/products", createProductRouter(db));
    app.use("/admin/orders", createOrderRouter(db));

    app.use(notFound);
    app.use(errorHandler);

    return app;
}

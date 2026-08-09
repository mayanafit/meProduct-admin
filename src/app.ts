import express from "express";
import type { Express } from "express";
import methodOverride from "method-override";
import path from "node:path";
import type { Database as DB } from "better-sqlite3";
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
    // Lets HTML forms issue PUT/DELETE via a hidden `_method` field.
    app.use(methodOverride("_method"));
    app.use(express.static(path.join(ROOT, "public")));

    app.get("/", (_req, res) => {
        const { count } = db
            .prepare("SELECT COUNT(*) AS count FROM products")
            .get() as { count: number };

        res.render("home", { title: "Dashboard", productCount: count });
    });

    // Routers mount here in Phase 3.

    app.use(notFound);
    app.use(errorHandler);

    return app;
}

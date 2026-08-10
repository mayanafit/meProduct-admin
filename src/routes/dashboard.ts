import { Router } from "express";
import type { Database as DB } from "better-sqlite3";
import { listProducts } from "../repositories/product.js";
import { listOrders } from "../repositories/order.js";

/** At or below this many units, a product is worth flagging. */
export const LOW_STOCK_THRESHOLD = 10;

const RECENT_ORDER_LIMIT = 5;

/**
 * The landing page. Both panels are derived from the existing list queries
 * rather than new SQL — at this scale filtering in JS is cheaper than another
 * query path to maintain, and it reuses code that's already covered.
 */
export function createDashboardRouter(db: DB): Router {
    const router = Router();

    router.get("/", (_req, res) => {
        const products = listProducts(db);
        const orders = listOrders(db);

        res.render("home", {
            title: "Dashboard",
            productCount: products.length,
            orderCount: orders.length,
            lowStock: products
                .filter((product) => product.stock_quantity <= LOW_STOCK_THRESHOLD)
                .sort((a, b) => a.stock_quantity - b.stock_quantity),
            recentOrders: orders.slice(0, RECENT_ORDER_LIMIT),
            threshold: LOW_STOCK_THRESHOLD,
        });
    });

    return router;
}

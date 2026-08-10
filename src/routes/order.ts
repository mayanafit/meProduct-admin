import { Router } from "express";
import type { Database as DB } from "better-sqlite3";
import { AppError, isAppError } from "../errors.js";
import { listOrders, getOrderWithItems } from "../repositories/order.js";
import { listProducts } from "../repositories/product.js";
import { placeOrder, cancelOrder, setOrderStatus } from "../services/order.js";
import type { OrderStatus } from "../types.js";
import { readString, readId, readQuantityFields } from "./formValues.js";

/**
 * Order pages. As with products, validation failures re-render the form with
 * the message inline; anything else goes to the error page.
 */
export function createOrderRouter(db: DB): Router {
    const router = Router();

    function requireId(raw: string | undefined): number {
        const id = readId(raw);
        if (id === undefined) {
            throw new AppError("That order id is not valid.", 404);
        }
        return id;
    }

    function loadOrderOrThrow(id: number) {
        const order = getOrderWithItems(db, id);
        if (order === undefined) {
            throw new AppError(`Order ${id} does not exist.`, 404);
        }
        return order;
    }

    router.get("/", (_req, res) => {
        res.render("orders/index", { title: "Orders", orders: listOrders(db) });
    });

    router.get("/new", (_req, res) => {
        res.render("orders/new", {
            title: "New order",
            error: null,
            products: listProducts(db),
            customerName: "",
            quantities: {},
        });
    });

    router.post("/", (req, res) => {
        const customerName = readString(req.body, "customer_name") ?? "";
        const lines = readQuantityFields(req.body);

        try {
            const order = placeOrder(db, { customerName, lines });
            res.redirect(`${req.baseUrl}/${order.id}`);
        } catch (err) {
            if (!isAppError(err)) throw err;

            res.status(err.status).render("orders/new", {
                title: "New order",
                error: err.message,
                products: listProducts(db),
                customerName,
                // Give the user back what they entered rather than a blank form.
                quantities: Object.fromEntries(
                    lines.map((line) => [line.productId, line.quantity])
                ),
            });
        }
    });

    router.get("/:id", (req, res) => {
        const order = loadOrderOrThrow(requireId(req.params.id));

        res.render("orders/show", { title: `Order #${order.id}`, order, error: null });
    });

    router.post("/:id/status", (req, res) => {
        const id = requireId(req.params.id);

        try {
            setOrderStatus(db, id, (readString(req.body, "status") ?? "") as OrderStatus);
        } catch (err) {
            if (!isAppError(err) || err.status === 404) throw err;

            const order = loadOrderOrThrow(id);
            res.status(err.status).render("orders/show", {
                title: `Order #${order.id}`,
                order,
                error: err.message,
            });
            return;
        }

        res.redirect(`${req.baseUrl}/${id}`);
    });

    router.post("/:id/cancel", (req, res) => {
        const id = requireId(req.params.id);

        try {
            cancelOrder(db, id);
        } catch (err) {
            if (!isAppError(err) || err.status === 404) throw err;

            const order = loadOrderOrThrow(id);
            res.status(err.status).render("orders/show", {
                title: `Order #${order.id}`,
                order,
                error: err.message,
            });
            return;
        }

        res.redirect(`${req.baseUrl}/${id}`);
    });

    return router;
}

import { Router } from "express";
import type { Database as DB } from "better-sqlite3";
import type { ProductUpdate } from "../types.js";
import { AppError, isAppError } from "../errors.js";
import { listProducts } from "../repositories/product.js";
import { listMovementsForProduct } from "../repositories/stockMovement.js";
import {
    createProduct,
    updateProductDetails,
    archiveProductById,
    adjustStockWithReason,
    getProductOrThrow,
} from "../services/product.js";
import { readString, readNumber, readId } from "./formValues.js";

/**
 * Product pages. Routes parse form input and choose what to render; all rules
 * live in `services/product.ts`.
 *
 * Validation failures re-render the submitted form with the message inline,
 * which keeps the user's typing. Everything else (missing product, bad id) is
 * thrown on to the error page.
 */
export function createProductRouter(db: DB): Router {
    const router = Router();

    function requireId(raw: string | undefined): number {
        const id = readId(raw);
        if (id === undefined) {
            throw new AppError("That product id is not valid.", 404);
        }
        return id;
    }

    router.get("/", (_req, res) => {
        res.render("products/index", { title: "Products", products: listProducts(db) });
    });

    router.get("/new", (_req, res) => {
        res.render("products/new", {
            title: "New product",
            error: null,
            values: { name: "", sku: "", price: "", description: "", stock_quantity: "0" },
        });
    });

    router.post("/", (req, res) => {
        try {
            createProduct(db, {
                name: readString(req.body, "name") ?? "",
                sku: readString(req.body, "sku") ?? null,
                description: readString(req.body, "description") ?? null,
                price: readNumber(req.body, "price") ?? Number.NaN,
                stock_quantity: readNumber(req.body, "stock_quantity") ?? 0,
            });
        } catch (err) {
            if (!isAppError(err)) throw err;

            res.status(err.status).render("products/new", {
                title: "New product",
                error: err.message,
                values: {
                    name: readString(req.body, "name") ?? "",
                    sku: readString(req.body, "sku") ?? "",
                    price: readString(req.body, "price") ?? "",
                    description: readString(req.body, "description") ?? "",
                    stock_quantity: readString(req.body, "stock_quantity") ?? "",
                },
            });
            return;
        }

        res.redirect(req.baseUrl);
    });

    router.get("/:id", (req, res) => {
        const product = getProductOrThrow(db, requireId(req.params.id));

        res.render("products/show", {
            title: product.name,
            product,
            movements: listMovementsForProduct(db, product.id),
            error: null,
        });
    });

    router.get("/:id/edit", (req, res) => {
        const product = getProductOrThrow(db, requireId(req.params.id));

        res.render("products/edit", { title: `Edit ${product.name}`, product, error: null });
    });

    router.put("/:id", (req, res) => {
        const id = requireId(req.params.id);

        // Only send fields the form actually submitted, so a partial form can't
        // silently blank out columns it doesn't show.
        const patch: ProductUpdate = {};
        const name = readString(req.body, "name");
        const sku = readString(req.body, "sku");
        const description = readString(req.body, "description");
        const price = readNumber(req.body, "price");

        if (name !== undefined) patch.name = name;
        if (sku !== undefined) patch.sku = sku;
        if (description !== undefined) patch.description = description;
        if (price !== undefined) patch.price = price;

        try {
            updateProductDetails(db, id, patch);
        } catch (err) {
            if (!isAppError(err) || err.status === 404) throw err;

            res.status(err.status).render("products/edit", {
                title: "Edit product",
                // Show what they typed, not what's stored.
                product: { ...getProductOrThrow(db, id), ...patch },
                error: err.message,
            });
            return;
        }

        res.redirect(`${req.baseUrl}/${id}`);
    });

    router.delete("/:id", (req, res) => {
        archiveProductById(db, requireId(req.params.id));
        res.redirect(req.baseUrl);
    });

    router.post("/:id/stock", (req, res) => {
        const id = requireId(req.params.id);

        try {
            adjustStockWithReason(db, id, readNumber(req.body, "delta") ?? Number.NaN, "adjustment");
        } catch (err) {
            if (!isAppError(err) || err.status === 404) throw err;

            const product = getProductOrThrow(db, id);
            res.status(err.status).render("products/show", {
                title: product.name,
                product,
                movements: listMovementsForProduct(db, id),
                error: err.message,
            });
            return;
        }

        res.redirect(`${req.baseUrl}/${id}`);
    });

    return router;
}

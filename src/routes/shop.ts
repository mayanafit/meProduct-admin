import { Router } from "express";
import type { Request } from "express";
import type { Database as DB } from "better-sqlite3";
import type { Cart } from "../types.js";
import { AppError, isAppError } from "../errors.js";
import { listProducts, getProductById } from "../repositories/product.js";
import { getOrderByReference, getOrderWithItems } from "../repositories/order.js";
import { placeOrder } from "../services/order.js";
import {
    addToCart,
    setCartQuantity,
    clearCart,
    cartLines,
    cartCount,
    resolveCart,
} from "../services/cart.js";
import { readString, readNumber, readId } from "./formValues.js";

/**
 * The customer-facing storefront. It writes through the same `placeOrder`
 * service the admin uses, so a customer order lands in the admin order list,
 * decrements stock and logs movements with no separate code path.
 */
export function createShopRouter(db: DB): Router {
    const router = Router();

    function getCart(req: Request): Cart {
        return req.session.cart ?? {};
    }

    function requireProductId(raw: string | undefined): number {
        const id = readId(raw);
        if (id === undefined) {
            throw new AppError("That product does not exist.", 404);
        }
        return id;
    }

    /** Shop pages are public, so an archived product must read as gone. */
    function requireOnSaleProduct(raw: string | undefined) {
        const product = getProductById(db, requireProductId(raw));

        if (product === undefined || product.archived_at !== null) {
            throw new AppError("That product does not exist.", 404);
        }
        return product;
    }

    // Every shop page renders the nav badge.
    router.use((req, res, next) => {
        res.locals["cartCount"] = cartCount(getCart(req));
        next();
    });

    router.get("/", (_req, res) => {
        res.render("shop/index", { title: "Shop", products: listProducts(db) });
    });

    router.get("/products/:id", (req, res) => {
        const product = requireOnSaleProduct(req.params.id);

        res.render("shop/product", { title: product.name, product, error: null });
    });

    router.post("/cart", (req, res) => {
        const product = requireOnSaleProduct(readString(req.body, "product_id"));
        const quantity = readNumber(req.body, "quantity") ?? 1;

        if (!Number.isInteger(quantity) || quantity < 1) {
            res.status(400).render("shop/product", {
                title: product.name,
                product,
                error: "Enter a quantity of at least 1.",
            });
            return;
        }

        req.session.cart = addToCart(getCart(req), product.id, quantity);
        res.redirect("/cart");
    });

    router.post("/cart/:productId", (req, res) => {
        const productId = requireProductId(req.params.productId);
        // A blank or unparseable box means "remove", which setCartQuantity does at 0.
        const quantity = readNumber(req.body, "quantity") ?? 0;

        req.session.cart = setCartQuantity(getCart(req), productId, quantity);
        res.redirect("/cart");
    });

    router.get("/cart", (req, res) => {
        res.render("shop/cart", { title: "Your cart", cart: resolveCart(db, getCart(req)) });
    });

    router.get("/checkout", (req, res) => {
        const cart = resolveCart(db, getCart(req));

        if (cart.items.length === 0) {
            res.redirect("/cart");
            return;
        }

        res.render("shop/checkout", {
            title: "Checkout",
            cart,
            error: null,
            values: { customer_name: "", customer_email: "" },
        });
    });

    router.post("/checkout", (req, res) => {
        const values = {
            customer_name: readString(req.body, "customer_name") ?? "",
            customer_email: readString(req.body, "customer_email") ?? "",
        };
        const cart = getCart(req);

        try {
            if (cartLines(cart).length === 0) {
                throw new AppError("Your cart is empty.", 400);
            }
            if (values.customer_name.trim() === "") {
                throw new AppError("Please enter your name.", 400);
            }
            if (values.customer_email.trim() === "") {
                throw new AppError("Please enter your email address.", 400);
            }

            const order = placeOrder(db, {
                customerName: values.customer_name,
                customerEmail: values.customer_email,
                lines: cartLines(cart),
            });

            req.session.cart = clearCart();
            res.redirect(`/order/${order.reference}`);
        } catch (err) {
            if (!isAppError(err)) throw err;

            res.status(err.status).render("shop/checkout", {
                title: "Checkout",
                cart: resolveCart(db, cart),
                error: err.message,
                values,
            });
        }
    });

    /**
     * Looked up by reference, never by id: sequential ids would let anyone
     * enumerate other customers' orders.
     */
    router.get("/order/:reference", (req, res) => {
        const reference = req.params.reference ?? "";
        const summary = getOrderByReference(db, reference);
        const order = summary === undefined ? undefined : getOrderWithItems(db, summary.id);

        if (order === undefined) {
            throw new AppError("We couldn't find that order.", 404);
        }

        res.render("shop/confirmation", { title: `Order ${order.reference}`, order });
    });

    return router;
}

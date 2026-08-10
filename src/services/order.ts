import type { Database as DB } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { NewOrder, NewOrderLine, OrderStatus, OrderWithItems, Product } from "../types.js";
import { AppError } from "../errors.js";
import * as orders from "../repositories/order.js";
import { getProductOrThrow, adjustStockWithReason } from "./product.js";

/**
 * Order placement and cancellation. Both run inside a single transaction so the
 * order, its line items, the stock decrement and the audit rows either all land
 * or none do.
 */

/**
 * Collapses repeated lines for the same product into one. Without this, two
 * lines of 6 against 10 in stock would each pass their own check and overdraw.
 */
function normaliseLines(lines: readonly NewOrderLine[]): NewOrderLine[] {
    const byProduct = new Map<number, number>();

    for (const line of lines) {
        if (!Number.isInteger(line.quantity)) {
            throw new AppError("Quantity must be a whole number.", 400);
        }
        if (line.quantity < 1) {
            throw new AppError("Quantity must be at least 1.", 400);
        }

        byProduct.set(line.productId, (byProduct.get(line.productId) ?? 0) + line.quantity);
    }

    return [...byProduct].map(([productId, quantity]) => ({ productId, quantity }));
}

/** Resolves a line's product, rejecting anything that can't be sold right now. */
function resolveOrderable(db: DB, line: NewOrderLine): Product {
    const product = getProductOrThrow(db, line.productId);

    if (product.archived_at !== null) {
        throw new AppError(`"${product.name}" is no longer available.`, 400);
    }
    if (product.stock_quantity < line.quantity) {
        throw new AppError(
            `Cannot order ${line.quantity} of "${product.name}" — only ${product.stock_quantity} in stock.`,
            400
        );
    }

    return product;
}

function getOrderWithItemsOrThrow(db: DB, id: number): OrderWithItems {
    const order = orders.getOrderWithItems(db, id);
    if (order === undefined) {
        throw new AppError(`Order ${id} does not exist.`, 404);
    }
    return order;
}

/**
 * Deliberately loose: a shape check, not an RFC-5322 parser. It catches typos
 * without rejecting addresses that are unusual but valid.
 */
function cleanEmail(email: string | null | undefined): string | null {
    const trimmed = email?.trim() ?? "";
    if (trimmed === "") return null;

    const [local, domain, ...rest] = trimmed.split("@");
    if (rest.length > 0 || !local || !domain || !domain.includes(".")) {
        throw new AppError(`"${trimmed}" is not a valid email address.`, 400);
    }

    return trimmed;
}

export function placeOrder(db: DB, input: NewOrder): OrderWithItems {
    const lines = normaliseLines(input.lines);

    if (lines.length === 0) {
        throw new AppError("An order needs at least one line item.", 400);
    }

    const customerName = input.customerName?.trim() || null;
    const customerEmail = cleanEmail(input.customerEmail);

    const place = db.transaction((): number => {
        // Validate every line before writing anything, so the reported error is
        // about the offending product rather than whichever line came first.
        const resolved = lines.map((line) => ({ line, product: resolveOrderable(db, line) }));

        const orderId = orders.insertOrder(db, {
            customerName,
            customerEmail,
            reference: randomUUID(),
        });

        for (const { line, product } of resolved) {
            orders.insertOrderItem(db, {
                orderId,
                productId: product.id,
                quantity: line.quantity,
                // Snapshot: editing the product's price later must not change
                // what this order was worth.
                unitPrice: product.price,
            });

            adjustStockWithReason(db, product.id, -line.quantity, "order", orderId);
        }

        return orderId;
    });

    return getOrderWithItemsOrThrow(db, place());
}

/**
 * Which statuses each state may move to. `cancelled` is deliberately absent
 * from every list: cancelling has stock consequences and belongs to
 * `cancelOrder` alone, so there is exactly one code path that restores stock.
 * `shipped` and `cancelled` are terminal.
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
    pending: ["paid", "shipped"],
    paid: ["shipped"],
    shipped: [],
    cancelled: [],
};

/**
 * Advances an order through its lifecycle.
 *
 * Status changes move no stock — the goods were committed when the order was
 * placed, and `cancelOrder` is the only thing that writes reversing movements.
 * Do not add stock effects here.
 */
export function setOrderStatus(db: DB, id: number, status: OrderStatus): OrderWithItems {
    // Guard before touching the database: without this the schema's CHECK
    // constraint would surface as a raw SQLite error instead of a message.
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, status)) {
        throw new AppError(`"${status}" is not a valid order status.`, 400);
    }

    const order = getOrderWithItemsOrThrow(db, id);

    if (order.status === status) {
        throw new AppError(`Order ${id} is already ${status}.`, 409);
    }
    if (!ALLOWED_TRANSITIONS[order.status].includes(status)) {
        throw new AppError(
            `Order ${id} is ${order.status} and cannot be marked ${status}.`,
            409
        );
    }

    orders.updateOrderStatus(db, id, status);

    return getOrderWithItemsOrThrow(db, id);
}

/**
 * Reverses an order's stock effects. The original 'order' movements stay put —
 * the reversal is recorded as its own 'order_cancelled' entry, so the audit log
 * reads as a history rather than being rewritten.
 */
export function cancelOrder(db: DB, id: number): OrderWithItems {
    const cancel = db.transaction((): void => {
        const order = getOrderWithItemsOrThrow(db, id);

        if (order.status === "cancelled") {
            throw new AppError(`Order ${id} is already cancelled.`, 409);
        }
        if (order.status === "shipped") {
            throw new AppError(`Order ${id} has already shipped and cannot be cancelled.`, 409);
        }

        for (const item of order.items) {
            // Restocking an archived product is fine — it's returning goods,
            // not selling them, so `resolveOrderable` deliberately isn't used.
            adjustStockWithReason(db, item.product_id, item.quantity, "order_cancelled", id);
        }

        orders.updateOrderStatus(db, id, "cancelled");
    });

    cancel();

    return getOrderWithItemsOrThrow(db, id);
}

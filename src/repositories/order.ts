import type { Database as DB } from "better-sqlite3";
import type {
    Order,
    OrderItemWithProduct,
    OrderStatus,
    OrderSummary,
    OrderWithItems,
} from "../types.js";

/** SQL for `orders` and `order_items`. Business rules live in `services/order.ts`. */

export interface NewOrderItemRow {
    orderId: number;
    productId: number;
    quantity: number;
    /** Snapshot of the product's price at the moment the order was placed. */
    unitPrice: number;
}

/**
 * Newest first. `created_at` has second resolution, so id breaks ties.
 * The LEFT JOIN keeps orders with no line items in the list, and COALESCE turns
 * their NULL total into 0.
 */
export function listOrders(db: DB): OrderSummary[] {
    return db
        .prepare(
            `SELECT o.id, o.customer_name, o.customer_email, o.reference, o.status, o.created_at,
                    COUNT(oi.id) AS item_count,
                    COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total
             FROM orders o
             LEFT JOIN order_items oi ON oi.order_id = o.id
             GROUP BY o.id
             ORDER BY o.created_at DESC, o.id DESC`
        )
        .all() as OrderSummary[];
}

const ORDER_COLUMNS = `id, customer_name, customer_email, reference, status, created_at`;

export function getOrderById(db: DB, id: number): Order | undefined {
    return db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`).get(id) as
        | Order
        | undefined;
}

/** Lookup by the public reference, for the customer's confirmation page. */
export function getOrderByReference(db: DB, reference: string): Order | undefined {
    return db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE reference = ?`).get(reference) as
        | Order
        | undefined;
}

/** The order plus its line items, each joined to its product name. */
export function getOrderWithItems(db: DB, id: number): OrderWithItems | undefined {
    const order = getOrderById(db, id);
    if (order === undefined) return undefined;

    const items = db
        .prepare(
            `SELECT oi.id, oi.order_id, oi.product_id, oi.quantity, oi.unit_price,
                    p.name AS product_name
             FROM order_items oi
             JOIN products p ON p.id = oi.product_id
             WHERE oi.order_id = ?
             ORDER BY oi.id`
        )
        .all(id) as OrderItemWithProduct[];

    const total = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);

    return { ...order, items, total };
}

export interface NewOrderRow {
    customerName: string | null;
    customerEmail: string | null;
    /** Callers generate this; the service does it so every order gets one. */
    reference: string;
}

/** Returns the new order's id. Status defaults to 'pending' in the schema. */
export function insertOrder(db: DB, order: NewOrderRow): number {
    const result = db
        .prepare(
            `INSERT INTO orders (customer_name, customer_email, reference)
             VALUES (@customer_name, @customer_email, @reference)`
        )
        .run({
            customer_name: order.customerName,
            customer_email: order.customerEmail,
            reference: order.reference,
        });

    return Number(result.lastInsertRowid);
}

export function insertOrderItem(db: DB, item: NewOrderItemRow): number {
    const result = db
        .prepare(
            `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
             VALUES (@order_id, @product_id, @quantity, @unit_price)`
        )
        .run({
            order_id: item.orderId,
            product_id: item.productId,
            quantity: item.quantity,
            unit_price: item.unitPrice,
        });

    return Number(result.lastInsertRowid);
}

/** Returns false if no such order exists. */
export function updateOrderStatus(db: DB, id: number, status: OrderStatus): boolean {
    const result = db.prepare(`UPDATE orders SET status = ? WHERE id = ?`).run(status, id);

    return result.changes > 0;
}

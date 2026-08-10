/** Row and input shapes. Row interfaces mirror the schema in `db/index.ts` exactly. */

export interface Product {
    id: number;
    name: string;
    /** UNIQUE but nullable in the schema. */
    sku: string | null;
    price: number;
    description: string | null;
    stock_quantity: number;
    created_at: string;
    /** NULL while the product is active. */
    archived_at: string | null;
}

export interface NewProduct {
    name: string;
    sku: string | null;
    price: number;
    description: string | null;
    stock_quantity: number;
}

/** Only these columns may be changed; anything absent is left untouched. */
export interface ProductUpdate {
    name?: string;
    sku?: string | null;
    price?: number;
    description?: string | null;
    stock_quantity?: number;
}

/**
 * Why a stock level changed. Free text in SQLite, constrained here so the set
 * stays discoverable and the UI can label each one.
 */
export type StockReason =
    | "initial_stock"
    | "order"
    | "order_cancelled"
    | "adjustment";

export interface StockMovement {
    id: number;
    product_id: number;
    quantity_change: number;
    reason: StockReason;
    /** The order id for order-driven movements; NULL otherwise. */
    reference_id: number | null;
    created_at: string;
}

export interface NewStockMovement {
    productId: number;
    quantityChange: number;
    reason: StockReason;
    referenceId?: number | null;
}

export type OrderStatus = "pending" | "paid" | "shipped" | "cancelled";

export interface Order {
    id: number;
    customer_name: string | null;
    customer_email: string | null;
    /** Unguessable public handle, used for the customer's confirmation page. */
    reference: string;
    status: OrderStatus;
    created_at: string;
}

export interface OrderItem {
    id: number;
    order_id: number;
    product_id: number;
    quantity: number;
    /** Snapshot of the product price when the order was placed. */
    unit_price: number;
}

/** A line item joined to its product name, for display. */
export interface OrderItemWithProduct extends OrderItem {
    product_name: string;
}

/** List-page row: the order plus its rolled-up totals. */
export interface OrderSummary extends Order {
    item_count: number;
    total: number;
}

export interface OrderWithItems extends Order {
    items: OrderItemWithProduct[];
    total: number;
}

/** One line of a not-yet-placed order. */
export interface NewOrderLine {
    productId: number;
    quantity: number;
}

export interface NewOrder {
    customerName: string | null;
    /** Optional: admin-placed orders often have no email. */
    customerEmail?: string | null;
    lines: NewOrderLine[];
}

/**
 * A customer's basket: product id → quantity, and nothing else.
 * Names and prices are resolved from the database on every render so they can
 * never go stale; `placeOrder` remains the only place a price is snapshotted.
 */
export type Cart = Record<number, number>;

/** A cart line resolved against current catalogue data. */
export interface CartItem {
    product: Product;
    quantity: number;
    lineTotal: number;
}

/** Something that will block checkout, surfaced on the cart page before it does. */
export interface CartIssue {
    productId: number;
    productName: string;
    message: string;
}

export interface ResolvedCart {
    items: CartItem[];
    total: number;
    itemCount: number;
    issues: CartIssue[];
}

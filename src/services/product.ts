import type { Database as DB } from "better-sqlite3";
import type { NewProduct, Product, ProductUpdate, StockReason } from "../types.js";
import { AppError } from "../errors.js";
import * as products from "../repositories/product.js";
import { recordMovement } from "../repositories/stockMovement.js";

/**
 * Business rules for products. Validation lives here rather than in routes so
 * it holds no matter which caller writes — the routes only parse form strings.
 */

function cleanName(name: string): string {
    const trimmed = name.trim();
    if (trimmed === "") {
        throw new AppError("Name is required.", 400);
    }
    return trimmed;
}

/** Blank means "no sku" — storing "" would collide under the UNIQUE index. */
function cleanSku(sku: string | null): string | null {
    const trimmed = sku?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
}

function assertPrice(price: number): void {
    if (!Number.isFinite(price) || price <= 0) {
        throw new AppError("Price must be greater than 0.", 400);
    }
}

function assertStock(quantity: number): void {
    if (!Number.isFinite(quantity) || quantity < 0) {
        throw new AppError("Stock quantity cannot be negative.", 400);
    }
    if (!Number.isInteger(quantity)) {
        throw new AppError("Stock quantity must be a whole number.", 400);
    }
}

/** Guards the UNIQUE index so callers get a readable message, not a SQLite error. */
function assertSkuAvailable(db: DB, sku: string | null, exceptId?: number): void {
    if (sku === null) return;

    const existing = products.getProductBySku(db, sku);
    if (existing !== undefined && existing.id !== exceptId) {
        throw new AppError(`SKU "${sku}" is already in use.`, 409);
    }
}

export function getProductOrThrow(db: DB, id: number): Product {
    const product = products.getProductById(db, id);
    if (product === undefined) {
        throw new AppError(`Product ${id} does not exist.`, 404);
    }
    return product;
}

/**
 * Creates a product and its opening `initial_stock` movement in one
 * transaction, so a product can never exist without a history entry.
 */
export function createProduct(db: DB, input: NewProduct): Product {
    const name = cleanName(input.name);
    const sku = cleanSku(input.sku);
    assertPrice(input.price);
    assertStock(input.stock_quantity);

    const create = db.transaction((): number => {
        assertSkuAvailable(db, sku);

        const id = products.insertProduct(db, {
            name,
            sku,
            price: input.price,
            description: input.description,
            stock_quantity: input.stock_quantity,
        });

        recordMovement(db, {
            productId: id,
            quantityChange: input.stock_quantity,
            reason: "initial_stock",
        });

        return id;
    });

    return getProductOrThrow(db, create());
}

/** Validates and applies only the fields present on `fields`. */
export function updateProductDetails(db: DB, id: number, fields: ProductUpdate): Product {
    getProductOrThrow(db, id);

    const patch: ProductUpdate = {};

    if (fields.name !== undefined) patch.name = cleanName(fields.name);
    if (fields.price !== undefined) {
        assertPrice(fields.price);
        patch.price = fields.price;
    }
    if (fields.stock_quantity !== undefined) {
        assertStock(fields.stock_quantity);
        patch.stock_quantity = fields.stock_quantity;
    }
    if (Object.prototype.hasOwnProperty.call(fields, "description")) {
        patch.description = fields.description ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(fields, "sku")) {
        const sku = cleanSku(fields.sku ?? null);
        assertSkuAvailable(db, sku, id);
        patch.sku = sku;
    }

    products.updateProduct(db, id, patch);

    return getProductOrThrow(db, id);
}

/** Soft delete — see the schema comment on `products.archived_at`. */
export function archiveProductById(db: DB, id: number): void {
    const product = getProductOrThrow(db, id);

    if (product.archived_at !== null) {
        throw new AppError(`"${product.name}" is already archived.`, 409);
    }

    products.archiveProduct(db, id);
}

/**
 * The only supported way to change stock outside of an order: the quantity
 * update and its audit row are written together or not at all.
 */
export function adjustStockWithReason(
    db: DB,
    id: number,
    delta: number,
    reason: StockReason,
    referenceId?: number
): Product {
    if (!Number.isInteger(delta)) {
        throw new AppError("Stock adjustment must be a whole number.", 400);
    }
    if (delta === 0) {
        throw new AppError("Stock adjustment must not be zero.", 400);
    }

    const adjust = db.transaction((): void => {
        const product = getProductOrThrow(db, id);

        if (product.stock_quantity + delta < 0) {
            throw new AppError(
                `Cannot remove ${Math.abs(delta)} of "${product.name}" — only ${product.stock_quantity} in stock.`,
                400
            );
        }

        products.adjustStock(db, id, delta);
        recordMovement(db, {
            productId: id,
            quantityChange: delta,
            reason,
            referenceId: referenceId ?? null,
        });
    });

    adjust();

    return getProductOrThrow(db, id);
}

/**
 * Turning form strings into typed values. Everything arrives from
 * `express.urlencoded` as `string | undefined` (or nested objects), so routes
 * parse shape here and leave meaning to the services.
 */

export function readString(body: unknown, field: string): string | undefined {
    if (typeof body !== "object" || body === null) return undefined;

    const value = (body as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
}

/**
 * `NaN` for anything unparseable, which the service layer rejects with a
 * readable message — no need to duplicate validation here.
 */
export function readNumber(body: unknown, field: string): number | undefined {
    const raw = readString(body, field);
    if (raw === undefined || raw.trim() === "") return undefined;

    return Number(raw);
}

/** A path parameter that must be a positive integer id. */
export function readId(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;

    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : undefined;
}

/**
 * Reads `quantity_<productId>` fields from the order form.
 *
 * Flat underscore names rather than `quantity[<id>]` on purpose: Express's
 * extended parser (qs) reads bracketed *numeric* keys as array indices and then
 * compacts the holes, so `quantity[7]=2` arrives as `["2"]` and the product id
 * is lost. A flat key has no such special meaning.
 *
 * Blank and zero entries are dropped so untouched rows aren't ordered.
 */
export function readQuantityFields(
    body: unknown,
    prefix = "quantity_"
): { productId: number; quantity: number }[] {
    if (typeof body !== "object" || body === null) return [];

    return Object.entries(body as Record<string, unknown>)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, raw]) => ({
            productId: Number(key.slice(prefix.length)),
            quantity: typeof raw === "string" && raw.trim() !== "" ? Number(raw) : 0,
        }))
        .filter(
            (line) =>
                Number.isInteger(line.productId) && line.productId > 0 && line.quantity > 0
        );
}

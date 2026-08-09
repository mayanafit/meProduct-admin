import type { Request, Response, NextFunction } from "express";
import { isAppError } from "../errors.js";

/**
 * Terminal error handler. `AppError` messages are written for users and are
 * rendered as-is; anything else is unexpected, so it's logged server-side and
 * reported as a bare 500 rather than leaking internals into the page.
 */
export function errorHandler(
    err: unknown,
    _req: Request,
    res: Response,
    next: NextFunction
): void {
    // Express can't swap in the error page once the response has started.
    if (res.headersSent) {
        next(err);
        return;
    }

    const status = isAppError(err) ? err.status : 500;
    const message = isAppError(err) ? err.message : "Something went wrong.";

    if (!isAppError(err)) {
        console.error(err);
    }

    res.status(status).render("error", { title: `Error ${status}`, status, message });
}

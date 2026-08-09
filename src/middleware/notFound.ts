import type { Request, Response, NextFunction } from "express";
import { AppError } from "../errors.js";

/**
 * Mounted after every router: anything still unmatched is a 404. Hands off to
 * the error handler so all error rendering lives in one place.
 */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
    next(new AppError(`Not found: ${req.method} ${req.originalUrl}`, 404));
}

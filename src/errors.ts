/**
 * An error whose message is safe to show the user, carrying the HTTP status the
 * response should use. Services throw these for expected failures (missing row,
 * failed validation, insufficient stock); anything else becomes a generic 500.
 */
export class AppError extends Error {
    readonly status: number;

    constructor(message: string, status = 400) {
        super(message);
        this.name = "AppError";
        this.status = status;
    }
}

export function isAppError(err: unknown): err is AppError {
    return err instanceof AppError;
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = 'APP_ERROR',
  ) {
    super(message);
  }
}

export function notFound(entity: string): AppError {
  return new AppError(404, `${entity} not found`, 'NOT_FOUND');
}

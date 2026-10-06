export class AppError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'AppError'
  }
}

export function publicError(error: unknown): string {
  return error instanceof AppError ? error.message : '服务暂时不可用，请稍后重试'
}

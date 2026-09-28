export class ServiceError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
export function publicError(error: unknown): ServiceError {
  return error instanceof ServiceError ? error : new ServiceError(503, "service_unavailable",
    "A dependency failed or returned invalid data. Check service configuration and retry.");
}

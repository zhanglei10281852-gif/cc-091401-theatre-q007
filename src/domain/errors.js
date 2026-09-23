// 业务错误：携带 code 与 HTTP 状态，便于接口给出可解释响应。
export class HttpError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (code, message, details) =>
  new HttpError(code, message, { status: 400, details });

export const notFound = (code, message) =>
  new HttpError(code, message, { status: 404 });

export const conflict = (code, message, details) =>
  new HttpError(code, message, { status: 409, details });

export const forbidden = (code, message) =>
  new HttpError(code, message, { status: 403 });

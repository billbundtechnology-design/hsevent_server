import type { ErrorRequestHandler } from 'express';
import multer from 'multer';
import { AppError } from './http-error.js';

const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  const errorType =
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    typeof error.type === 'string'
      ? error.type
      : '';
  const status =
    error instanceof AppError
      ? error.status
      : error instanceof multer.MulterError
        ? error.code === 'LIMIT_FILE_SIZE'
          ? 413
          : 400
        : errorType === 'entity.parse.failed'
          ? 400
          : errorType === 'entity.too.large'
            ? 413
            : 500;
  const code =
    error instanceof AppError
      ? error.code
      : error instanceof multer.MulterError
        ? status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : 'INVALID_UPLOAD'
        : status === 400
          ? 'MALFORMED_REQUEST'
          : status === 413
            ? 'PAYLOAD_TOO_LARGE'
            : 'INTERNAL_SERVER_ERROR';
  const detail =
    error instanceof AppError
      ? error.message
      : error instanceof multer.MulterError
        ? status === 413
          ? 'The image upload exceeds the 5 MiB limit.'
          : 'The image upload is invalid.'
        : status === 400
          ? 'The request body contains invalid JSON.'
          : status === 413
            ? 'The request body exceeds the 1 MB limit.'
            : 'An unexpected error occurred.';
  const requestId = String(request.id);
  if (error instanceof AppError && error.headers) {
    for (const [name, value] of Object.entries(error.headers)) {
      response.setHeader(name, value);
    }
  }

  const errorName =
    typeof error === 'object' && error !== null && 'name' in error
      ? String(error.name)
      : 'UnknownError';
  request.log[status === 500 ? 'error' : 'warn']({ errorName, requestId }, 'Request failed');

  const problem = {
    type: `https://api.rentos.example/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title:
      status === 400
        ? 'Malformed request'
        : status === 413
          ? 'Payload too large'
          : status === 500
            ? 'Internal server error'
            : status === 401
              ? 'Authentication required'
              : status === 403
                ? 'Forbidden'
                : status === 422
                  ? 'Request validation failed'
                  : 'Request failed',
    status,
    code,
    detail,
    requestId,
    ...(error instanceof AppError && error.errors ? { errors: error.errors } : {}),
  };

  response.status(status).type('application/problem+json').json(problem);
};

export default errorHandler;

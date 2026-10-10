import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError } from './http-error.js';

export const validateBody = <Schema extends ZodType>(schema: Schema): RequestHandler =>
  (request, _response, next) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      }));
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'One or more fields are invalid.',
        errors,
      );
    }

    request.body = parsed.data;
    next();
  };

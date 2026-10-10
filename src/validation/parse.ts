import type { ZodType } from 'zod';
import { AppError } from '../middleware/http-error.js';

export const parseOrThrow = <Schema extends ZodType>(
  schema: Schema,
  value: unknown,
): Schema['_output'] => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new AppError(
    422,
    'VALIDATION_ERROR',
    'One or more fields are invalid.',
    parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    })),
  );
};

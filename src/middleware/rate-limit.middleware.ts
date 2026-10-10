import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';

interface RateLimiterOptions {
  windowMs: number;
  limit: number;
  code: string;
  detail: string;
}

export const createRateLimiter = ({
  windowMs,
  limit,
  code,
  detail,
}: RateLimiterOptions): RequestHandler =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (request, response) => {
      response.status(429).type('application/problem+json').json({
        type: `https://api.rentos.example/problems/${code.toLowerCase().replaceAll('_', '-')}`,
        title: 'Too many requests',
        status: 429,
        code,
        detail,
        requestId: String(request.id),
      });
    },
  });

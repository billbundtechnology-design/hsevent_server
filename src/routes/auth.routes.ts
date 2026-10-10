import { Router } from 'express';
import {
  getMe,
  loginUser,
} from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { createRateLimiter } from '../middleware/rate-limit.middleware.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { loginSchema } from '../validation/auth.schemas.js';

const authRouter = Router();
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  code: 'RATE_LIMITED',
  detail: 'Too many login attempts. Please try again later.',
});

authRouter.post('/login', loginLimiter, validateBody(loginSchema), loginUser);
authRouter.get('/me', authenticate, getMe);

export default authRouter;

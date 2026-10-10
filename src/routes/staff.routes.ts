import { Router } from 'express';
import {
  acceptInvitationController,
  createInvitationController,
  getStaffController,
  listInvitationsController,
  listStaffController,
  revokeInvitationController,
  revokeStaffTokensController,
  updateStaffController,
} from '../controllers/staff.controller.js';
import { authenticate, requirePermission } from '../middleware/auth.middleware.js';
import { createRateLimiter } from '../middleware/rate-limit.middleware.js';

const staffRouter = Router();
staffRouter.post(
  '/invitations/accept',
  createRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    code: 'RATE_LIMITED',
    detail: 'Too many invitation attempts. Please try again later.',
  }),
  acceptInvitationController,
);
staffRouter.use(authenticate);
staffRouter.get('/', requirePermission('staff.read'), listStaffController);
staffRouter.get('/invitations', requirePermission('staff.read'), listInvitationsController);
staffRouter.delete('/invitations/:id', requirePermission('staff.manage'), revokeInvitationController);
staffRouter.get('/:id', requirePermission('staff.read'), getStaffController);
staffRouter.patch('/:id', requirePermission('staff.manage'), updateStaffController);
staffRouter.post(
  '/invitations',
  requirePermission('staff.manage'),
  createInvitationController,
);
staffRouter.delete(
  '/:id/tokens',
  requirePermission('staff.manage'),
  revokeStaffTokensController,
);

export default staffRouter;

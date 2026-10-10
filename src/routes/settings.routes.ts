import { Router } from 'express';
import {
  getRoleSettingsController,
  getSettingsController,
  updateBookingPoliciesController,
  updateBusinessProfileController,
  updateInvoiceBrandingController,
  updateNotificationsController,
} from '../controllers/settings.controller.js';
import { authenticate, requirePermission } from '../middleware/auth.middleware.js';

const settingsRouter = Router();
settingsRouter.use(authenticate);
settingsRouter.get('/', requirePermission('settings.read'), getSettingsController);
settingsRouter.get('/roles', requirePermission('settings.read'), getRoleSettingsController);
settingsRouter.patch('/business-profile', requirePermission('settings.manage'), updateBusinessProfileController);
settingsRouter.patch('/booking-policies', requirePermission('settings.manage'), updateBookingPoliciesController);
settingsRouter.patch('/notifications', requirePermission('settings.manage'), updateNotificationsController);
settingsRouter.patch('/invoice-branding', requirePermission('settings.manage'), updateInvoiceBrandingController);

export default settingsRouter;

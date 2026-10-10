import { Router } from 'express';
import {
  checklistController,
  createDispatchController,
  getDispatchController,
  listDispatchesController,
  markDispatchedController,
  markReturnedController,
  updateDispatchController,
} from '../controllers/dispatch.controller.js';
import { authenticate, requirePermission } from '../middleware/auth.middleware.js';

const dispatchRouter = Router();
dispatchRouter.use(authenticate);
dispatchRouter.get('/', requirePermission('dispatch.read'), listDispatchesController);
dispatchRouter.get('/:id', requirePermission('dispatch.read'), getDispatchController);
dispatchRouter.patch('/:id', requirePermission('dispatch.write'), updateDispatchController);
dispatchRouter.post('/:id/checklist', requirePermission('dispatch.update'), checklistController);
dispatchRouter.post('/:id/mark-dispatched', requirePermission('dispatch.update'), markDispatchedController);
dispatchRouter.post('/:id/mark-returned', requirePermission('dispatch.update'), markReturnedController);

export default dispatchRouter;

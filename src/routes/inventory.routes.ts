import { Router } from 'express';
import {
  adjustStockController,
  createInventoryController,
  getInventoryAvailabilityController,
  getInventoryController,
  listInventoryController,
  reportConditionController,
  updateInventoryController,
  uploadInventoryImageController,
} from '../controllers/inventory.controller.js';
import { authenticate, requirePermission } from '../middleware/auth.middleware.js';
import { imageUpload } from '../middleware/image-upload.middleware.js';

const inventoryRouter = Router();
inventoryRouter.use(authenticate);
inventoryRouter.get('/', requirePermission('inventory.read'), listInventoryController);
inventoryRouter.post('/', requirePermission('inventory.write'), createInventoryController);
inventoryRouter.post(
  '/images',
  requirePermission('inventory.write'),
  imageUpload.single('image'),
  uploadInventoryImageController,
);
inventoryRouter.get('/:id', requirePermission('inventory.read'), getInventoryController);
inventoryRouter.patch('/:id', requirePermission('inventory.write'), updateInventoryController);
inventoryRouter.post('/:id/stock-adjustments', requirePermission('inventory.adjust'), adjustStockController);
inventoryRouter.post('/:id/condition-reports', requirePermission('inventory.adjust'), reportConditionController);
inventoryRouter.get('/:id/availability', requirePermission('inventory.read'), getInventoryAvailabilityController);

export default inventoryRouter;

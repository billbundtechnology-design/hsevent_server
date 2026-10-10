import type { Permission, Role } from './permissions.js';

export interface RequestAuthContext {
  userId: string;
  membershipId: string;
  businessId: string;
  role: Role;
  permissions: readonly Permission[];
}

declare global {
  namespace Express {
    interface Request {
      authContext?: RequestAuthContext;
    }
  }
}

export const staffRoles = [
  'manager',
  'booking_staff',
  'inventory_staff',
  'delivery_staff',
  'finance_staff',
] as const;

export const roles = [
  'owner',
  ...staffRoles,
] as const;

export type Role = (typeof roles)[number];

export const permissions = [
  'bookings.read',
  'bookings.write',
  'bookings.approve',
  'bookings.cancel',
  'bookings.complete',
  'customers.read',
  'customers.write',
  'catalogue.read',
  'catalogue.write',
  'catalogue.publish',
  'inventory.read',
  'inventory.write',
  'inventory.adjust',
  'venues.read',
  'venues.write',
  'dispatch.read',
  'dispatch.write',
  'dispatch.update',
  'payments.read',
  'payments.record',
  'payments.refund',
  'reports.read',
  'reports.export',
  'staff.read',
  'staff.manage',
  'settings.read',
  'settings.manage',
] as const;

export type Permission = (typeof permissions)[number];

const allPermissions: readonly Permission[] = permissions;

const rolePermissions: Record<Role, readonly Permission[]> = {
  owner: allPermissions,
  manager: [
    'bookings.read',
    'bookings.write',
    'bookings.approve',
    'bookings.cancel',
    'bookings.complete',
    'customers.read',
    'customers.write',
    'catalogue.read',
    'catalogue.write',
    'catalogue.publish',
    'inventory.read',
    'inventory.write',
    'inventory.adjust',
    'venues.read',
    'venues.write',
    'dispatch.read',
    'dispatch.write',
    'dispatch.update',
    'reports.read',
    'reports.export',
    'settings.read',
  ],
  booking_staff: [
    'bookings.read',
    'bookings.write',
    'bookings.approve',
    'bookings.cancel',
    'customers.read',
    'customers.write',
  ],
  inventory_staff: [
    'catalogue.read',
    'inventory.read',
    'inventory.write',
    'inventory.adjust',
  ],
  delivery_staff: ['bookings.read', 'dispatch.read', 'dispatch.write', 'dispatch.update'],
  finance_staff: [
    'bookings.read',
    'customers.read',
    'payments.read',
    'payments.record',
    'payments.refund',
    'reports.read',
    'reports.export',
  ],
};

export const getPermissionsForRole = (role: Role): readonly Permission[] =>
  rolePermissions[role];

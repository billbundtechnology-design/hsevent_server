import { AppError } from '../middleware/http-error.js';
import { AuditEvent } from '../models/audit-event.model.js';
import { Business } from '../models/business.model.js';
import { getPermissionsForRole, roles, type Role } from '../auth/permissions.js';

const getBusiness = async (businessId: string) => {
  const business = await Business.findOne({ id: businessId });
  if (!business) throw new AppError(404, 'BUSINESS_NOT_FOUND', 'Business settings were not found.');
  return business;
};

const saveAudit = async (
  businessId: string,
  actorId: string,
  requestId: string,
  action: string,
  details: Record<string, unknown>,
) => AuditEvent.create({
  businessId,
  actorId,
  requestId,
  resourceType: 'settings',
  resourceId: businessId,
  action,
  details,
});

export const getSettings = async (businessId: string) => {
  const business = await getBusiness(businessId);
  return {
    businessProfile: {
      id: business.id,
      name: business.name,
      address: business.address ?? null,
      currency: business.currency,
      timezone: business.timezone,
    },
    bookingPolicies: {
      depositPercent: business.bookingPolicies?.depositPercent ?? 0,
      taxPercent: business.bookingPolicies?.taxPercent ?? 0,
      cancellationCutoffHours: business.bookingPolicies?.cancellationCutoffHours ?? 0,
      refundPercentBeforeCutoff: business.bookingPolicies?.refundPercentBeforeCutoff ?? 100,
      refundPercentAfterCutoff: business.bookingPolicies?.refundPercentAfterCutoff ?? 0,
    },
    notifications: {
      bookingRequests: business.notifications?.bookingRequests ?? true,
      payments: business.notifications?.payments ?? true,
      dispatch: business.notifications?.dispatch ?? true,
      returns: business.notifications?.returns ?? true,
    },
    invoiceBranding: {
      displayName: business.invoiceBranding?.displayName ?? null,
      footer: business.invoiceBranding?.footer ?? null,
    },
  };
};

export const updateBusinessProfile = async (
  businessId: string,
  actorId: string,
  requestId: string,
  input: { name?: string; address?: string | null; currency?: 'NGN'; timezone?: 'Africa/Lagos' },
) => {
  const business = await getBusiness(businessId);
  Object.assign(business, input);
  await business.save();
  await saveAudit(businessId, actorId, requestId, 'settings.business_profile_updated', {
    fields: Object.keys(input),
  });
  return getSettings(businessId);
};

export const updateBookingPolicies = async (
  businessId: string,
  actorId: string,
  requestId: string,
  input: {
    depositPercent?: number;
    taxPercent?: number;
    cancellationCutoffHours?: number;
    refundPercentBeforeCutoff?: number;
    refundPercentAfterCutoff?: number;
  },
) => {
  const business = await getBusiness(businessId);
  for (const [field, value] of Object.entries(input)) {
    if (value !== undefined) business.set(`bookingPolicies.${field}`, value);
  }
  await business.save();
  await saveAudit(businessId, actorId, requestId, 'settings.booking_policies_updated', {
    fields: Object.keys(input),
  });
  return getSettings(businessId);
};

export const updateNotifications = async (
  businessId: string,
  actorId: string,
  requestId: string,
  input: {
    bookingRequests?: boolean;
    payments?: boolean;
    dispatch?: boolean;
    returns?: boolean;
  },
) => {
  const business = await getBusiness(businessId);
  for (const [field, value] of Object.entries(input)) {
    if (value !== undefined) business.set(`notifications.${field}`, value);
  }
  await business.save();
  await saveAudit(businessId, actorId, requestId, 'settings.notifications_updated', {
    fields: Object.keys(input),
  });
  return getSettings(businessId);
};

export const updateInvoiceBranding = async (
  businessId: string,
  actorId: string,
  requestId: string,
  input: { displayName?: string | null; footer?: string | null },
) => {
  const business = await getBusiness(businessId);
  business.invoiceBranding = { ...business.invoiceBranding, ...input };
  await business.save();
  await saveAudit(businessId, actorId, requestId, 'settings.invoice_branding_updated', {
    fields: Object.keys(input),
  });
  return getSettings(businessId);
};

const roleDescriptions: Record<Role, string> = {
  owner: 'Full access to business operations, staff, security, and settings.',
  manager: 'Manage bookings, customers, catalogue, inventory, venues, dispatch, reports, and read settings.',
  booking_staff: 'Manage bookings and customer records.',
  inventory_staff: 'Manage catalogue and inventory stock.',
  delivery_staff: 'Read bookings and manage dispatch/return operations.',
  finance_staff: 'Read bookings and manage payments, refunds, and financial reports.',
};

export const getRoleSettings = () => ({
  roles: roles.map((role) => ({
    role,
    description: roleDescriptions[role],
    permissions: getPermissionsForRole(role),
  })),
});

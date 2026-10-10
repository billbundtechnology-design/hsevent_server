import { randomUUID } from 'node:crypto';
import { Customer } from '../models/customer.model.js';
import { AppError } from '../middleware/http-error.js';

export interface CustomerListInput {
  q?: string;
  type?: 'private' | 'corporate';
  archived: 'true' | 'false';
  page: number;
  pageSize: number;
}

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const customerNotFound = (): AppError =>
  new AppError(404, 'NOT_FOUND', 'Customer was not found.');

export const listCustomers = async (
  businessId: string,
  input: CustomerListInput,
) => {
  const filter: Record<string, unknown> = { businessId };
  if (input.type) filter.type = input.type;
  filter.archivedAt = input.archived === 'true' ? { $ne: null } : null;
  if (input.q) {
    const query = new RegExp(escapeRegex(input.q), 'i');
    filter.$or = [{ name: query }, { email: query }, { phone: query }, { companyName: query }];
  }

  const [customers, total] = await Promise.all([
    Customer.find(filter)
      .sort({ createdAt: -1, id: 1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean(),
    Customer.countDocuments(filter),
  ]);

  return {
    data: customers,
    meta: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      totalPages: Math.ceil(total / input.pageSize),
    },
  };
};

export const createCustomer = async (
  businessId: string,
  input: {
    name: string;
    email?: string;
    phone?: string;
    type: 'private' | 'corporate';
    companyName?: string | null;
    address?: string | null;
  },
) => {
  const customer = await Customer.create({
    id: randomUUID(),
    businessId,
    ...input,
    email: input.email ?? null,
    phone: input.phone?.replace(/[\s()-]/g, '') ?? null,
  });
  return customer.toObject();
};

export const getCustomer = async (businessId: string, id: string) => {
  const customer = await Customer.findOne({ businessId, id }).lean();
  if (!customer) throw customerNotFound();
  return customer;
};

export const updateCustomer = async (
  businessId: string,
  id: string,
  input: {
    name?: string;
    email?: string | null;
    phone?: string | null;
    type?: 'private' | 'corporate';
    companyName?: string | null;
    address?: string | null;
    version: number;
  },
) => {
  const { version, ...updates } = input;
  const current = await Customer.findOne({ businessId, id }).lean();
  if (!current) throw customerNotFound();
  if (current.archivedAt) {
    throw new AppError(409, 'CUSTOMER_ARCHIVED', 'Archived customers cannot be updated.');
  }
  const resultingType = updates.type ?? current.type;
  const resultingCompanyName =
    updates.companyName === undefined ? current.companyName : updates.companyName;
  if (resultingType === 'corporate' && !resultingCompanyName) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      'Company name is required for corporate customers.',
    );
  }
  if (updates.phone) updates.phone = updates.phone.replace(/[\s()-]/g, '');

  const customer = await Customer.findOneAndUpdate(
    { businessId, id, version, archivedAt: null },
    { $set: updates, $inc: { version: 1 } },
    { new: true, runValidators: true },
  ).lean();
  if (customer) return customer;

  const existing = await Customer.findOne({ businessId, id }).lean();
  if (!existing) throw customerNotFound();
  if (existing.archivedAt) {
    throw new AppError(409, 'CUSTOMER_ARCHIVED', 'Archived customers cannot be updated.');
  }
  throw new AppError(
    409,
    'VERSION_CONFLICT',
    'The customer was changed by another request. Reload and retry.',
    undefined,
    { ETag: `W/"${existing.version}"` },
  );
};

export const archiveCustomer = async (businessId: string, id: string) => {
  const customer = await Customer.findOneAndUpdate(
    { businessId, id, archivedAt: null },
    { $set: { archivedAt: new Date() }, $inc: { version: 1 } },
    { new: true },
  ).lean();
  if (customer) return customer;

  const existing = await Customer.findOne({ businessId, id }).lean();
  if (!existing) throw customerNotFound();
  throw new AppError(409, 'CUSTOMER_ARCHIVED', 'Customer is already archived.');
};

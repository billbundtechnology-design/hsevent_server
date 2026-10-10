import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Invitation } from '../models/invitation.model.js';
import { Membership } from '../models/membership.model.js';
import { User } from '../models/user.model.js';
import { AuditEvent } from '../models/audit-event.model.js';
import { AppError } from '../middleware/http-error.js';
import type { StaffRole } from '../validation/staff.schemas.js';

const INVITATION_TTL_MS = 1000 * 60 * 60 * 72;

const hashInvitationToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const staffNotFound = (): AppError =>
  new AppError(404, 'NOT_FOUND', 'Staff member was not found.');

export const listStaff = async (
  businessId: string,
  input: {
    q?: string;
    status?: 'active' | 'invited' | 'suspended';
    page: number;
    pageSize: number;
  },
) => {
  const filter: Record<string, unknown> = { businessId };
  if (input.status) filter.status = input.status;
  let matchingUserIds: string[] | undefined;
  if (input.q) {
    const escaped = input.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matchingUsers = await User.find({
      $or: [{ name: new RegExp(escaped, 'i') }, { email: new RegExp(escaped, 'i') }],
    }).select('id').lean();
    matchingUserIds = matchingUsers.map((user) => user.id);
    filter.userId = { $in: matchingUserIds };
  }
  const [memberships, total] = await Promise.all([
    Membership.find(filter)
      .sort({ createdAt: -1, id: 1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean(),
    Membership.countDocuments(filter),
  ]);
  const users = await User.find({ id: { $in: memberships.map((membership) => membership.userId) } })
    .select('id name email active')
    .lean();
  const userById = new Map(users.map((user) => [user.id, user]));
  const data = memberships.flatMap((membership) => {
    const user = userById.get(membership.userId);
    return user ? [{
      id: membership.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      role: membership.role,
      status: membership.status,
      active: user.active,
      createdAt: membership.createdAt,
      updatedAt: membership.updatedAt,
    }] : [];
  });
  return {
    data,
    meta: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      totalPages: Math.ceil(total / input.pageSize),
    },
  };
};

export const getStaffMember = async (businessId: string, id: string) => {
  const membership = await Membership.findOne({ businessId, id }).lean();
  if (!membership) throw staffNotFound();
  const user = await User.findOne({ id: membership.userId }).select('id name email active').lean();
  if (!user) throw staffNotFound();
  return {
    id: membership.id,
    userId: user.id,
    name: user.name,
    email: user.email,
    role: membership.role,
    status: membership.status,
    active: user.active,
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt,
  };
};

export const updateStaffMember = async (
  businessId: string,
  id: string,
  input: { role?: StaffRole; status?: 'active' | 'suspended' },
  actorMembershipId: string,
  actorId: string,
  requestId: string,
) => {
  const membership = await Membership.findOne({ businessId, id });
  if (!membership) throw staffNotFound();
  if (membership.role === 'owner') {
    throw new AppError(403, 'FORBIDDEN', 'Owner memberships cannot be changed here.');
  }
  if (membership.status === 'invited') {
    throw new AppError(
      409,
      'INVITATION_PENDING',
      'Accept or replace the pending invitation before editing this membership.',
    );
  }
  if (membership.id === actorMembershipId && input.status === 'suspended') {
    throw new AppError(409, 'SELF_SUSPENSION_NOT_ALLOWED', 'You cannot suspend your own membership.');
  }

  if (input.role) membership.role = input.role;
  if (input.status) membership.status = input.status;
  await membership.save();
  await AuditEvent.create({
    businessId,
    actorId,
    requestId,
    resourceType: 'membership',
    resourceId: id,
    action: 'staff.updated',
    details: { fields: Object.keys(input) },
  });
  return getStaffMember(businessId, id);
};

export const createInvitation = async (
  businessId: string,
  createdBy: string,
  requestId: string,
  input: { email: string; role: StaffRole },
) => {
  let existingUser = await User.findOne({ email: input.email });
  let existingMembership = null;
  if (existingUser) {
    if (!existingUser.active) {
      throw new AppError(409, 'USER_INACTIVE', 'This user account is inactive.');
    }
    existingMembership = await Membership.findOne({
      businessId,
      userId: existingUser.id,
    });
    if (existingMembership) {
      if (existingMembership.status === 'invited' || existingMembership.status === 'suspended') {
        const pendingInvitation = await Invitation.exists({
          businessId,
          email: input.email,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { $gt: new Date() },
        });
        if (pendingInvitation) {
          throw new AppError(409, 'INVITATION_ALREADY_PENDING', 'An invitation is already pending for this email.');
        }
      } else {
        throw new AppError(409, 'STAFF_ALREADY_EXISTS', 'This user already has a membership for the business.');
      }
    }
  }

  const priorInvitation = await Invitation.findOne({
    businessId,
    email: input.email,
    acceptedAt: null,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (priorInvitation) {
    throw new AppError(409, 'INVITATION_ALREADY_PENDING', 'An invitation is already pending for this email.');
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const requiresAccountSetup = !existingUser;
  const priorMembershipState = existingMembership
    ? { role: existingMembership.role, status: existingMembership.status }
    : null;
  if (!existingUser) {
    existingUser = await User.create({
      id: randomUUID(),
      name: input.email.split('@')[0] ?? 'Invited staff',
      email: input.email,
      passwordHash: await bcrypt.hash(randomBytes(32).toString('hex'), 12),
    });
  }

  let createdMembershipId: string | undefined;
  let invitationId: string | undefined;
  try {
    if (existingMembership) {
      existingMembership.role = input.role;
      existingMembership.status = 'invited';
      await existingMembership.save();
    } else {
      createdMembershipId = randomUUID();
      await Membership.create({
        id: createdMembershipId,
        userId: existingUser.id,
        businessId,
        role: input.role,
        status: 'invited',
      });
    }
    const invitation = await Invitation.create({
      id: randomUUID(),
      businessId,
      email: input.email,
      role: input.role,
      tokenHash: hashInvitationToken(token),
      expiresAt,
      requiresAccountSetup,
      createdBy,
    });
    invitationId = invitation.id;
    await AuditEvent.create({
      businessId,
      actorId: createdBy,
      requestId,
      resourceType: 'invitation',
      resourceId: invitation.id,
      action: 'staff.invitation_created',
      details: { email: input.email, role: input.role },
    });
  } catch (error) {
    if (invitationId) await Invitation.deleteOne({ id: invitationId });
    if (createdMembershipId) await Membership.deleteOne({ id: createdMembershipId });
    if (existingMembership && priorMembershipState) {
      existingMembership.role = priorMembershipState.role;
      existingMembership.status = priorMembershipState.status;
      await existingMembership.save();
    }
    if (requiresAccountSetup) await User.deleteOne({ id: existingUser.id });
    throw error;
  }

  return {
    id: invitationId,
    email: input.email,
    role: input.role,
    invitationToken: token,
    expiresAt: expiresAt.toISOString(),
    delivery: 'manual',
  };
};

export const listInvitations = async (
  businessId: string,
  input: { status?: 'pending' | 'accepted' | 'expired' | 'revoked'; q?: string; page: number; pageSize: number },
) => {
  const now = new Date();
  const filter: Record<string, unknown> = { businessId };
  if (input.q) {
    const escaped = input.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.email = new RegExp(escaped, 'i');
  }
  const records = await Invitation.find(filter)
    .sort({ createdAt: -1, id: 1 })
    .lean();
  const filtered = records.filter((invitation) => {
    const status = invitation.revokedAt
      ? 'revoked'
      : invitation.acceptedAt
        ? 'accepted'
        : invitation.expiresAt <= now
          ? 'expired'
          : 'pending';
    return !input.status || status === input.status;
  });
  const total = filtered.length;
  const data = filtered
    .slice((input.page - 1) * input.pageSize, input.page * input.pageSize)
    .map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.revokedAt
        ? 'revoked'
        : invitation.acceptedAt
          ? 'accepted'
          : invitation.expiresAt <= now
            ? 'expired'
            : 'pending',
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      revokedAt: invitation.revokedAt ?? null,
      createdAt: invitation.createdAt,
    }));
  return {
    data,
    meta: { page: input.page, pageSize: input.pageSize, total, totalPages: Math.ceil(total / input.pageSize) },
  };
};

export const revokeInvitation = async (
  businessId: string,
  id: string,
  actorId: string,
  requestId: string,
) => {
  const invitation = await Invitation.findOneAndUpdate(
    { businessId, id, acceptedAt: null, revokedAt: null },
    { $set: { revokedAt: new Date() } },
    { new: true },
  );
  if (!invitation) {
    const existing = await Invitation.findOne({ businessId, id }).lean();
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Invitation was not found.');
    throw new AppError(409, 'INVITATION_NOT_PENDING', 'Only a pending invitation can be revoked.');
  }
  const user = await User.findOne({ email: invitation.email }).select('id').lean();
  if (user) {
    await Membership.updateOne(
      { businessId, userId: user.id, status: 'invited' },
      { $set: { status: 'suspended' } },
    );
  }
  await AuditEvent.create({
    businessId,
    actorId,
    requestId,
    resourceType: 'invitation',
    resourceId: id,
    action: 'staff.invitation_revoked',
    details: { email: invitation.email },
  });
  return { id, status: 'revoked' };
};

export const acceptInvitation = async (input: {
  token: string;
  name?: string;
  password?: string;
}) => {
  const acceptedAt = new Date();
  const invitation = await Invitation.findOneAndUpdate(
    {
      tokenHash: hashInvitationToken(input.token),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { $gt: acceptedAt },
    },
    { $set: { acceptedAt } },
    { new: true },
  ).select('+tokenHash');
  if (!invitation) {
    throw new AppError(400, 'INVALID_INVITATION', 'Invitation is invalid or expired.');
  }

  try {
    const user = await User.findOne({ email: invitation.email }).select('+authVersion');
    if (!user) {
      throw new AppError(409, 'INVITATION_INVALID', 'The invitation account is no longer available.');
    }
    if (!user.active) {
      throw new AppError(409, 'USER_INACTIVE', 'This user account is inactive.');
    }
    if (invitation.requiresAccountSetup) {
      if (!input.name || !input.password) {
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          'Name and password are required to create a new account.',
        );
      }
      user.name = input.name;
      user.passwordHash = await bcrypt.hash(input.password, 12);
      user.authVersion += 1;
      await user.save();
    }

    const membership = await Membership.findOne({
      businessId: invitation.businessId,
      userId: user.id,
    });
    if (membership?.status === 'active') {
      throw new AppError(409, 'STAFF_ALREADY_EXISTS', 'This user already has an active membership.');
    }
    if (membership) {
      membership.role = invitation.role;
      membership.status = 'active';
      await membership.save();
    } else {
      await Membership.create({
        id: randomUUID(),
        userId: user.id,
        businessId: invitation.businessId,
        role: invitation.role,
        status: 'active',
      });
    }

    return { userId: user.id, businessId: invitation.businessId, role: invitation.role };
  } catch (error) {
    await Invitation.updateOne({ id: invitation.id, acceptedAt }, { $set: { acceptedAt: null } });
    throw error;
  }
};

export const revokeUserTokens = async (businessId: string, membershipId: string) => {
  const membership = await Membership.findOne({ businessId, id: membershipId });
  if (!membership) throw staffNotFound();
  if (membership.role === 'owner') {
    throw new AppError(403, 'FORBIDDEN', 'Owner tokens cannot be revoked here.');
  }
  const user = await User.findOneAndUpdate(
    { id: membership.userId },
    { $inc: { authVersion: 1 } },
    { new: true },
  ).select('id');
  if (!user) throw staffNotFound();
};

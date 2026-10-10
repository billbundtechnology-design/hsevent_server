import type { RequestHandler } from 'express';
import { AppError } from '../middleware/http-error.js';
import {
  acceptInvitation,
  createInvitation,
  getStaffMember,
  listInvitations,
  listStaff,
  revokeInvitation,
  revokeUserTokens,
  updateStaffMember,
} from '../services/staff.service.js';
import {
  invitationAcceptSchema,
  invitationCreateSchema,
  invitationIdParamSchema,
  invitationListSchema,
  staffIdParamSchema,
  staffListSchema,
  staffUpdateSchema,
} from '../validation/staff.schemas.js';
import { parseOrThrow } from '../validation/parse.js';

const getAuthContext = (request: Parameters<RequestHandler>[0]) => {
  const context = request.authContext;
  if (!context) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  return context;
};

export const listStaffController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const query = parseOrThrow(staffListSchema, request.query);
  response.json(await listStaff(context.businessId, query));
};

export const getStaffController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const { id } = parseOrThrow(staffIdParamSchema, request.params);
  response.json({ data: await getStaffMember(context.businessId, id) });
};

export const updateStaffController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const { id } = parseOrThrow(staffIdParamSchema, request.params);
  const input = parseOrThrow(staffUpdateSchema, request.body);
  response.json({
    data: await updateStaffMember(
      context.businessId,
      id,
      input,
      context.membershipId,
      context.userId,
      String(request.id),
    ),
  });
};

export const listInvitationsController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const query = parseOrThrow(invitationListSchema, request.query);
  response.json(await listInvitations(context.businessId, query));
};

export const createInvitationController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const input = parseOrThrow(invitationCreateSchema, request.body);
  response.status(201).json({
    data: await createInvitation(context.businessId, context.userId, String(request.id), input),
  });
};

export const revokeInvitationController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const { id } = parseOrThrow(invitationIdParamSchema, request.params);
  response.json({
    data: await revokeInvitation(context.businessId, id, context.userId, String(request.id)),
  });
};

export const acceptInvitationController: RequestHandler = async (request, response) => {
  const input = parseOrThrow(invitationAcceptSchema, request.body);
  response.status(201).json({ data: await acceptInvitation(input) });
};

export const revokeStaffTokensController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const { id } = parseOrThrow(staffIdParamSchema, request.params);
  await revokeUserTokens(context.businessId, id);
  response.status(204).end();
};

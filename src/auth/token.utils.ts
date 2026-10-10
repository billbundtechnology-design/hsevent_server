import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';

const signingKey = new TextEncoder().encode(env.JWT_SECRET);
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AccessTokenClaims {
  userId: string;
  membershipId: string;
  authVersion: number;
}

export const signAccessToken = async (
  claims: AccessTokenClaims,
): Promise<{ token: string; expiresAt: string }> => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((issuedAt + ACCESS_TOKEN_TTL_SECONDS) * 1000);
  const token = await new SignJWT({
    membershipId: claims.membershipId,
    authVersion: claims.authVersion,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
    .sign(signingKey);

  return { token, expiresAt: expiresAt.toISOString() };
};

export const verifyAccessToken = async (token: string): Promise<AccessTokenClaims> => {
  const { payload } = await jwtVerify(token, signingKey, { algorithms: ['HS256'] });
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.membershipId !== 'string' ||
    typeof payload.authVersion !== 'number'
  ) {
    throw new Error('Access token claims are invalid.');
  }

  return {
    userId: payload.sub,
    membershipId: payload.membershipId,
    authVersion: payload.authVersion,
  };
};

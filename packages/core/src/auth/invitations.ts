import { createHash, randomBytes } from 'node:crypto';

import type { Role } from '@repo/shared';
import { Types } from 'mongoose';

import { isFixtureRuntime } from '../config/runtime.js';
import { getModels } from '../db/models.js';
import type { InvitationDoc } from '../db/models/invitation.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.js';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a `claimed` invitation is reserved for the account creation that claimed it. If
 * account creation fails after the claim, the same invitee can retry once this has elapsed.
 */
export const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

export type InvitationTokenState = 'valid' | 'invalid' | 'expired' | 'revoked' | 'accepted';

export interface InvitationSummary {
  id: string;
  email: string;
  role: Role;
  status: InvitationDoc['status'];
  expiresAt: Date;
  invitedBy: string;
  createdAt: Date;
  acceptedAt: Date | null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

type InvitationRecord = InvitationDoc & { _id: unknown; createdAt?: Date };

function summarize(doc: InvitationRecord): InvitationSummary {
  return {
    id: String(doc._id),
    email: doc.email,
    role: doc.role,
    status: doc.status,
    expiresAt: doc.expiresAt,
    invitedBy: doc.invitedBy,
    createdAt: doc.createdAt ?? new Date(0),
    acceptedAt: doc.acceptedAt ?? null,
  };
}

/**
 * Issues a new invitation and returns the raw token exactly once. Any earlier live invitation
 * for the same email is revoked, so only the newest link works.
 */
/** The reserved domain every development fixture account uses. */
export const FIXTURE_EMAIL_DOMAIN = 'fixtures.example';

export async function createInvitation(input: {
  email: string;
  role: Role;
  invitedBy: string;
  now?: Date;
}): Promise<{ invitation: InvitationSummary; token: string }> {
  const { Invitation, AuthUser } = await getModels();
  const email = normalizeEmail(input.email);
  const now = input.now ?? new Date();

  if (await AuthUser.exists({ email })) {
    throw new ConflictError('USER_EXISTS', `${email} already has an account.`);
  }
  // Development fixture accounts exist only in the fixtures runtime, never in a real database.
  if (email.endsWith(`@${FIXTURE_EMAIL_DOMAIN}`) && !isFixtureRuntime()) {
    throw new AppError(
      'FIXTURE_ACCOUNT',
      'Development fixture accounts can only be created in the fixtures runtime.',
      422,
    );
  }

  await Invitation.updateMany(
    { email, status: { $in: ['pending', 'claimed'] } },
    { $set: { status: 'revoked', revokedAt: now } },
  );

  const token = newToken();
  const doc = await Invitation.create({
    email,
    role: input.role,
    tokenHash: hashInvitationToken(token),
    status: 'pending',
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    invitedBy: input.invitedBy,
  });

  return { invitation: summarize(doc.toObject()), token };
}

/** Classifies a token for the invitation landing page, without consuming it. */
export async function inspectInvitationToken(
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<{ state: InvitationTokenState; invitation?: InvitationSummary }> {
  if (!token) return { state: 'invalid' };
  const { Invitation } = await getModels();
  const doc = await Invitation.findOne({ tokenHash: hashInvitationToken(token) }).lean();
  if (!doc) return { state: 'invalid' };

  const invitation = summarize(doc);
  if (doc.status === 'accepted') return { state: 'accepted', invitation };
  if (doc.status === 'revoked') return { state: 'revoked', invitation };
  if (doc.expiresAt.getTime() <= now.getTime()) return { state: 'expired', invitation };
  return { state: 'valid', invitation };
}

export class InvitationRejectedError extends ForbiddenError {
  constructor(
    readonly reason:
      | 'INVITATION_REQUIRED'
      | 'INVITATION_INVALID'
      | 'INVITATION_EXPIRED'
      | 'INVITATION_REVOKED'
      | 'INVITATION_USED'
      | 'INVITATION_EMAIL_MISMATCH',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Whether `token` belongs to an invitation that `email` could claim right now. Read-only; used
 * to gate the public sign-up endpoint before Better Auth reveals whether an account exists.
 */
export async function hasClaimableInvitation(
  token: string | null | undefined,
  email: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!token) return false;
  const { Invitation } = await getModels();
  const match = await Invitation.exists({
    tokenHash: hashInvitationToken(token),
    email: normalizeEmail(email),
    expiresAt: { $gt: now },
    $or: [
      { status: 'pending' },
      { status: 'claimed', claimedAt: { $lt: new Date(now.getTime() - CLAIM_TIMEOUT_MS) } },
    ],
  });
  return match !== null;
}

/**
 * Atomically reserves an invitation for a new account. This is the security boundary for
 * sign-up: it succeeds only when the request presents the token of a pending, unexpired
 * invitation issued to exactly this email. The token was delivered to that address, which
 * proves control of it. The single conditional update means two concurrent sign-ups can never
 * both claim the same invitation.
 */
export async function claimInvitation(input: {
  token: string | null | undefined;
  email: string;
  now?: Date;
}): Promise<{ invitationId: string; role: Role }> {
  if (!input.token) {
    throw new InvitationRejectedError(
      'INVITATION_REQUIRED',
      'Access is by invitation only. Open the invitation link you were sent to join.',
    );
  }

  const { Invitation } = await getModels();
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);
  const tokenHash = hashInvitationToken(input.token);

  const claimed = await Invitation.findOneAndUpdate(
    {
      tokenHash,
      email,
      expiresAt: { $gt: now },
      $or: [
        { status: 'pending' },
        { status: 'claimed', claimedAt: { $lt: new Date(now.getTime() - CLAIM_TIMEOUT_MS) } },
      ],
    },
    { $set: { status: 'claimed', claimedAt: now } },
    { returnDocument: 'after' },
  ).lean();

  if (claimed) {
    return { invitationId: String(claimed._id), role: claimed.role };
  }

  // Explain the rejection precisely; the match itself already decided the outcome.
  const existing = await Invitation.findOne({ tokenHash }).lean();
  if (!existing) {
    throw new InvitationRejectedError('INVITATION_INVALID', 'This invitation link is not valid.');
  }
  if (existing.status === 'revoked') {
    throw new InvitationRejectedError('INVITATION_REVOKED', 'This invitation has been revoked.');
  }
  if (existing.status === 'accepted' || existing.status === 'claimed') {
    throw new InvitationRejectedError('INVITATION_USED', 'This invitation has already been used.');
  }
  if (existing.expiresAt.getTime() <= now.getTime()) {
    throw new InvitationRejectedError('INVITATION_EXPIRED', 'This invitation has expired.');
  }
  throw new InvitationRejectedError(
    'INVITATION_EMAIL_MISMATCH',
    'This invitation was issued to a different email address.',
  );
}

/**
 * Marks the claimed invitation as accepted once Better Auth has committed the new user. At most
 * one invitation per email is live (`createInvitation` revokes older ones), so the email
 * identifies it.
 */
export async function completeInvitation(input: {
  email: string;
  userId: string;
  now?: Date;
}): Promise<void> {
  const { Invitation } = await getModels();
  await Invitation.updateOne(
    { email: normalizeEmail(input.email), status: 'claimed' },
    {
      $set: {
        status: 'accepted',
        acceptedAt: input.now ?? new Date(),
        acceptedUserId: input.userId,
      },
    },
  );
}

export async function revokeInvitation(id: string, now: Date = new Date()): Promise<void> {
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError('No open invitation with that id.');
  }
  const { Invitation } = await getModels();
  const result = await Invitation.updateOne(
    { _id: id, status: { $in: ['pending', 'claimed'] } },
    { $set: { status: 'revoked', revokedAt: now } },
  );
  if (result.matchedCount === 0) {
    throw new NotFoundError('No open invitation with that id.');
  }
}

export async function listInvitations(): Promise<InvitationSummary[]> {
  const { Invitation } = await getModels();
  const docs = await Invitation.find().sort({ createdAt: -1 }).limit(200).lean();
  return docs.map(summarize);
}

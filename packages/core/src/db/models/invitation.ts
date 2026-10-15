import { ROLES } from '@repo/shared';
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const INVITATION_STATUSES = ['pending', 'claimed', 'accepted', 'revoked'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * An owner-issued, single-use, email-bound invitation. Only a SHA-256 hash of the token is
 * stored; the raw token exists only in the link given to the invitee.
 *
 * `claimed` is a short-lived state set while Better Auth creates the account, so a crash between
 * claiming and account creation doesn't burn the invitation (see `CLAIM_TIMEOUT_MS`).
 */
const invitationSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ROLES, required: true },
    tokenHash: { type: String, required: true, unique: true },
    status: { type: String, enum: INVITATION_STATUSES, required: true, default: 'pending' },
    expiresAt: { type: Date, required: true },
    invitedBy: { type: String, required: true },
    claimedAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    acceptedUserId: { type: String, default: null },
    revokedAt: { type: Date, default: null },
  },
  { collection: 'invitations', timestamps: true },
);

invitationSchema.index({ email: 1, status: 1 });

export type InvitationDoc = InferSchemaType<typeof invitationSchema>;

export function invitationModel(connection: Connection): Model<InvitationDoc> {
  return (
    (connection.models.Invitation as Model<InvitationDoc> | undefined) ??
    connection.model<InvitationDoc>('Invitation', invitationSchema)
  );
}

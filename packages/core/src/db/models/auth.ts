import { ROLES, USER_STATUSES } from '@repo/shared';
import { Schema, Types, type Connection, type InferSchemaType, type Model } from 'mongoose';

/**
 * Read/write views over collections that Better Auth owns (`user`, `session`). Better Auth
 * creates and indexes these itself, so the views never build indexes or collections; they
 * exist so our services can manage roles, deactivation and session revocation.
 */
const viewOptions = { autoIndex: false, autoCreate: false, timestamps: false } as const;

const authUserSchema = new Schema(
  {
    name: { type: String, default: '' },
    email: { type: String, required: true },
    emailVerified: { type: Boolean, default: false },
    image: { type: String, default: null },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: USER_STATUSES, required: true, default: 'active' },
    createdAt: { type: Date },
    updatedAt: { type: Date },
  },
  { ...viewOptions, collection: 'user' },
);

const authSessionSchema = new Schema(
  {
    // Better Auth's Mongo adapter stores references to `user.id` as ObjectIds.
    userId: { type: Schema.Types.ObjectId, required: true },
    expiresAt: { type: Date, required: true },
  },
  { ...viewOptions, collection: 'session', strict: false },
);

export type AuthUserDoc = InferSchemaType<typeof authUserSchema>;
export type AuthSessionDoc = InferSchemaType<typeof authSessionSchema>;

export function authUserModel(connection: Connection): Model<AuthUserDoc> {
  return (
    (connection.models.AuthUser as Model<AuthUserDoc> | undefined) ??
    connection.model<AuthUserDoc>('AuthUser', authUserSchema)
  );
}

export function authSessionModel(connection: Connection): Model<AuthSessionDoc> {
  return (
    (connection.models.AuthSession as Model<AuthSessionDoc> | undefined) ??
    connection.model<AuthSessionDoc>('AuthSession', authSessionSchema)
  );
}

export function toObjectId(id: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
}

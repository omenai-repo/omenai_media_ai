import type { Role, UserStatus } from '@repo/shared';

import { getModels } from '../db/models.js';
import { toObjectId, type AuthUserDoc } from '../db/models/auth.js';
import { ConflictError, NotFoundError } from '../errors.js';

export interface AppUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  role: Role;
  status: UserStatus;
  createdAt: Date | null;
}

function toAppUser(doc: AuthUserDoc & { _id: unknown }): AppUser {
  return {
    id: String(doc._id),
    email: doc.email,
    name: doc.name ?? '',
    image: doc.image ?? null,
    role: doc.role,
    status: doc.status,
    createdAt: doc.createdAt ?? null,
  };
}

export async function findUserById(id: string): Promise<AppUser | null> {
  const objectId = toObjectId(id);
  if (!objectId) return null;
  const { AuthUser } = await getModels();
  const doc = await AuthUser.findById(objectId).lean();
  return doc ? toAppUser(doc) : null;
}

export async function listUsers(): Promise<AppUser[]> {
  const { AuthUser } = await getModels();
  const docs = await AuthUser.find().sort({ createdAt: 1 }).lean();
  return docs.map(toAppUser);
}

async function countOtherActiveOwners(excludingId: string): Promise<number> {
  const { AuthUser } = await getModels();
  return AuthUser.countDocuments({
    role: 'owner',
    status: 'active',
    _id: { $ne: toObjectId(excludingId) },
  });
}

async function requireUser(id: string): Promise<AppUser> {
  const user = await findUserById(id);
  if (!user) throw new NotFoundError('User not found.');
  return user;
}

/**
 * Owners can change roles, but the workspace must always keep at least one active owner,
 * otherwise nobody could manage people again without database access.
 */
export async function setUserRole(input: { userId: string; role: Role }): Promise<AppUser> {
  const user = await requireUser(input.userId);
  if (user.role === 'owner' && input.role !== 'owner' && user.status === 'active') {
    if ((await countOtherActiveOwners(user.id)) === 0) {
      throw new ConflictError('LAST_OWNER', 'The workspace must keep at least one active owner.');
    }
  }
  const { AuthUser } = await getModels();
  await AuthUser.updateOne(
    { _id: toObjectId(user.id) },
    { $set: { role: input.role, updatedAt: new Date() } },
  );
  return { ...user, role: input.role };
}

/** Deactivation also deletes every session, so access ends immediately, not at expiry. */
export async function deactivateUser(input: { actorId: string; userId: string }): Promise<void> {
  if (input.actorId === input.userId) {
    throw new ConflictError('SELF_DEACTIVATION', 'You cannot deactivate your own account.');
  }
  const user = await requireUser(input.userId);
  if (user.role === 'owner' && (await countOtherActiveOwners(user.id)) === 0) {
    throw new ConflictError('LAST_OWNER', 'The workspace must keep at least one active owner.');
  }
  const { AuthUser, AuthSession } = await getModels();
  const objectId = toObjectId(user.id);
  await AuthUser.updateOne(
    { _id: objectId },
    { $set: { status: 'deactivated', updatedAt: new Date() } },
  );
  await AuthSession.deleteMany({ userId: objectId });
}

export async function reactivateUser(userId: string): Promise<void> {
  const user = await requireUser(userId);
  const { AuthUser } = await getModels();
  await AuthUser.updateOne(
    { _id: toObjectId(user.id) },
    { $set: { status: 'active', updatedAt: new Date() } },
  );
}

export async function hasActiveOwner(): Promise<boolean> {
  const { AuthUser } = await getModels();
  return (await AuthUser.exists({ role: 'owner', status: 'active' })) !== null;
}

/**
 * The newsroom has exactly two roles. Owners administer the workspace (people, invitations,
 * manual discovery runs); editors do all editorial work. Every check here is mirrored on the
 * server: hiding a control in the UI is never the security boundary.
 */
export const ROLES = ['owner', 'editor'] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ['active', 'deactivated'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

const OWNER_ONLY_ACTIONS = ['team:manage', 'invitations:manage', 'runs:trigger'] as const;

const EDITORIAL_ACTIONS = [
  'stories:read',
  'stories:decide',
  'research:request',
  'chat:write',
  'drafts:generate',
  'drafts:edit',
  'runs:read',
] as const;

export type Action = (typeof OWNER_ONLY_ACTIONS)[number] | (typeof EDITORIAL_ACTIONS)[number];

const PERMISSIONS: Record<Role, ReadonlySet<Action>> = {
  owner: new Set<Action>([...OWNER_ONLY_ACTIONS, ...EDITORIAL_ACTIONS]),
  editor: new Set<Action>(EDITORIAL_ACTIONS),
};

export function can(role: Role, action: Action): boolean {
  return PERMISSIONS[role].has(action);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

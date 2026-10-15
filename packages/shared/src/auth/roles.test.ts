import { describe, expect, it } from 'vitest';

import { can, isRole } from './roles.js';

describe('role permissions', () => {
  it.each(['team:manage', 'invitations:manage', 'runs:trigger'] as const)(
    'reserves %s for owners',
    (action) => {
      expect(can('owner', action)).toBe(true);
      expect(can('editor', action)).toBe(false);
    },
  );

  it.each(['stories:decide', 'research:request', 'drafts:generate', 'drafts:edit'] as const)(
    'lets both roles perform %s',
    (action) => {
      expect(can('owner', action)).toBe(true);
      expect(can('editor', action)).toBe(true);
    },
  );

  it('recognises only the two roles', () => {
    expect(isRole('owner')).toBe(true);
    expect(isRole('editor')).toBe(true);
    expect(isRole('admin')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe('authErrorMessage', () => {
  it('maps known codes and never echoes unknown input', async () => {
    const { authErrorMessage } = await import('./sign-in-errors.js');
    expect(authErrorMessage(null)).toBeNull();
    expect(authErrorMessage('INVITATION_EXPIRED')).toMatch(/expired/);
    expect(authErrorMessage('Call 555-0100 to restore access')).toBe(
      'Something went wrong. Please try again.',
    );
  });
});

describe('passwordProblem', () => {
  it('enforces the length policy', async () => {
    const { passwordProblem } = await import('./password.js');
    expect(passwordProblem('short')).toMatch(/at least 12/);
    expect(passwordProblem('a'.repeat(129))).toMatch(/at most 128/);
    expect(passwordProblem('correct horse battery')).toBeNull();
  });
});

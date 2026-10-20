import type { DraftFormatDto, DraftVersionDto } from '@repo/core';
import { describe, expect, it } from 'vitest';

import { formatStatus, limitText } from './format-status';

const version = (fields: Partial<DraftVersionDto>) =>
  ({
    version: 1,
    origin: 'generated',
    createdAt: '2026-10-19T22:44:00.000Z',
    checksFrom: 1,
    claims: [{ citationStatus: 'verified' }],
    ...fields,
  }) as unknown as DraftVersionDto;
const task = {} as DraftFormatDto['activeTask'];
const entry = (fields: Partial<DraftFormatDto>) =>
  ({ versions: [], activeTask: null, lastFailure: null, ...fields }) as DraftFormatDto;

describe('format status in the Studio sidebar', () => {
  it('says a format is not started, or that its only request didn’t finish', () => {
    expect(formatStatus(entry({}))).toEqual({ kind: 'empty' });
    expect(formatStatus(entry({ lastFailure: task }))).toEqual({ kind: 'failed' });
  });

  it('names the version being written', () => {
    expect(formatStatus(entry({ activeTask: task }))).toEqual({ kind: 'writing', next: 1 });
    expect(formatStatus(entry({ activeTask: task, versions: [version({ version: 3 })] }))).toEqual({
      kind: 'writing',
      next: 4,
    });
  });

  it('counts versions and reads the check state from the latest one only', () => {
    const generated = version({ version: 2, checksFrom: 2 });
    expect(formatStatus(entry({ versions: [generated, version({})] }))).toMatchObject({
      kind: 'drafted',
      versions: 2,
      checked: true,
      failedSince: false,
    });
  });

  it('never shows an edited version as checked, even when its source version was', () => {
    const edited = version({ version: 3, origin: 'edited', checksFrom: 2, claims: [] });
    expect(
      formatStatus(entry({ versions: [edited, version({ version: 2, checksFrom: 2 })] })),
    ).toMatchObject({ kind: 'drafted', checked: false });
  });

  it('doesn’t call a version with no listed statements checked', () => {
    expect(formatStatus(entry({ versions: [version({ claims: [] })] }))).toMatchObject({
      checked: false,
    });
  });

  it('keeps the versions and flags a later request that didn’t finish', () => {
    expect(formatStatus(entry({ versions: [version({})], lastFailure: task }))).toMatchObject({
      kind: 'drafted',
      versions: 1,
      failedSince: true,
    });
  });

  it('states each format’s length in its own unit', () => {
    expect(limitText('newsletter_item')).toBe('About 150–300 words');
    expect(limitText('x_post')).toBe('Up to 280 characters');
  });
});

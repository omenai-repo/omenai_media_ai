import type { DraftVersionDto, DraftsViewDto } from '@repo/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChecksPanel } from './side-panels';

/**
 * An edited version carries no checks of its own. The checks shown for it belong to the version
 * it came from and must never read as checks of the edited wording.
 */
const claim = {
  type: 'fact',
  text: 'The original wording of a checked statement.',
  sourceLabels: ['S1'],
  sourceIds: [],
  excerpt: 'a quote from the source',
  citationStatus: 'verified',
};
const version = (fields: Partial<DraftVersionDto>) =>
  ({
    version: 1,
    claims: [],
    sources: [],
    droppedClaims: 0,
    ...fields,
  }) as unknown as DraftVersionDto;
const view = { sources: {}, research: { toConfirm: [] } } as unknown as DraftsViewDto;

describe('draft checks panel', () => {
  const original = version({ version: 1, claims: [claim] as never });
  const edited = version({ version: 2, claims: [], checksFrom: 1 });

  it('labels an edited version’s checks as belonging to the version they were made on', () => {
    const html = renderToStaticMarkup(
      <ChecksPanel shown={edited} checked={original} view={view} />,
    );
    expect(html).toContain('This version’s text hasn’t been checked');
    expect(html).toContain('Checks for version 1, as first written');
    // The original statement sits inside the labelled section, after its heading.
    expect(html.indexOf('as first written')).toBeLessThan(html.indexOf(claim.text));
    expect(html).toContain('aria-label="Checks for version 1"');
  });

  it('shows no such label for the version the checks were made on', () => {
    const html = renderToStaticMarkup(
      <ChecksPanel shown={original} checked={original} view={view} />,
    );
    expect(html).not.toContain('hasn’t been checked. The checks below');
    expect(html).not.toContain('as first written');
  });
});

/**
 * Tavily client behaviour against a mocked SDK. This checks our mapping, batching and usage
 * recording; it says nothing about the live API (verified separately, see VERIFICATION.md).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const search = vi.fn();
const extract = vi.fn();
vi.mock('@tavily/core', () => ({ tavily: () => ({ search, extract }) }));
const recorded: unknown[] = [];
vi.mock('../db/models.js', () => ({
  getModels: () => Promise.resolve({ AiUsage: { create: (doc: unknown) => recorded.push(doc) } }),
}));

const { classifyTavilyError, createTavilySearchClient } = await import('./tavily.js');

afterEach(() => {
  search.mockReset();
  extract.mockReset();
  recorded.length = 0;
});

describe('classifyTavilyError', () => {
  it.each([
    ['Unauthorized: missing or invalid API key.', 'auth'],
    ['This request exceeds your plan’s set usage limit.', 'quota'],
    ['429 Error: {"detail":"Too many requests"}', 'rate_limited'],
    ['Request timed out after 60 seconds.', 'unavailable'],
    ['An unexpected error occurred while making the request.', 'unavailable'],
  ])('%s → %s', (message, kind) => {
    expect(classifyTavilyError(message)).toBe(kind);
  });
});

describe('Tavily search client', () => {
  const client = createTavilySearchClient({ apiKey: 'test' });

  it('requests news with usage, language and exclusions, and normalises results', async () => {
    search.mockResolvedValue({
      results: [
        {
          url: 'https://a.example/x',
          title: 'T',
          content: 'snippet',
          publishedDate: 'Mon, 12 Oct 2026 03:00:00 GMT',
          score: 0.9,
        },
      ],
      usage: { credits: 1 },
    });
    const hits = await client.search(
      'art Lagos',
      { maxResults: 8, timeRange: 'week', languages: ['en'], excludeDomains: ['pinterest.com'] },
      { runKey: 'r1' },
    );
    expect(search).toHaveBeenCalledWith(
      'art Lagos',
      expect.objectContaining({
        topic: 'news',
        timeRange: 'week',
        maxResults: 8,
        language: 'en',
        includeUsage: true,
        excludeDomains: ['pinterest.com'],
      }),
    );
    expect(hits).toEqual([
      {
        url: 'https://a.example/x',
        title: 'T',
        snippet: 'snippet',
        publishedDate: 'Mon, 12 Oct 2026 03:00:00 GMT',
        score: 0.9,
      },
    ]);
    expect(recorded).toEqual([
      expect.objectContaining({
        provider: 'tavily',
        kind: 'search',
        units: 1,
        outcome: 'ok',
        runKey: 'r1',
      }),
    ]);
  });

  it('raises a classified, recorded error', async () => {
    search.mockRejectedValue(new Error('429 Error: slow down'));
    const error = await client
      .search('q', { maxResults: 1, timeRange: 'day', languages: ['en'] })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'SearchError', kind: 'rate_limited', retryable: true });
    expect(recorded).toEqual([
      expect.objectContaining({ outcome: 'error', errorKind: 'rate_limited' }),
    ]);
  });

  it('extracts in batches of 20 and keeps per-URL failures', async () => {
    extract.mockImplementation((urls: string[]) =>
      Promise.resolve({
        results: urls.slice(1).map((url) => ({
          url,
          title: null,
          rawContent: `text of ${url}`,
          images: [`${url}/photo.jpg`],
        })),
        failedResults: [{ url: urls[0], error: 'blocked' }],
        usage: { credits: 1 },
      }),
    );
    const urls = Array.from({ length: 25 }, (_, i) => `https://a.example/${i}`);
    const { pages, failed } = await client.extract(urls);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(pages).toHaveLength(23);
    expect(pages[0]?.images).toEqual(['https://a.example/1/photo.jpg']);
    expect(extract).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ includeImages: true }),
    );
    expect(failed.map((f) => f.url)).toEqual(['https://a.example/0', 'https://a.example/20']);
  });

  it('turns a transient batch error into per-URL failures but stops on a permanent one', async () => {
    extract.mockRejectedValueOnce(new Error('Request timed out after 60 seconds.'));
    const transient = await client.extract(['https://a.example/1']);
    expect(transient.failed).toHaveLength(1);

    extract.mockRejectedValueOnce(new Error('Unauthorized: missing or invalid API key.'));
    await expect(client.extract(['https://a.example/1'])).rejects.toMatchObject({
      kind: 'auth',
      retryable: false,
    });
  });
});

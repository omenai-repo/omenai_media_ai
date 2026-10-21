/**
 * TEST FIXTURES ONLY. Invented articles and a scripted model for the intake tests: a fake search
 * that answers each query differently, and a model that keeps everything in scope, groups
 * articles by a "Topic-X" prefix and quotes each lead source so assessments pass the evidence
 * checks. Proves pipeline logic only, never real search or model behaviour.
 */
import { LlmError } from '../llm/types.js';
import type { SearchClient, SearchHit } from '../search/types.js';
import { fixtureEvaluation, fixtureKeyClaims, scores } from './discovery-fixtures.js';
import { createScriptedLlm, promptArticles } from './fake-llm.js';

export interface IntakeHit extends SearchHit {
  content: string;
}

export function intakeHit(
  slug: string,
  title: string,
  score: number,
  published = 'Wed, 14 Oct 2026 08:00:00 GMT',
): IntakeHit {
  return {
    url: `https://news.example/${slug}`,
    title,
    snippet: `${title}.`,
    publishedDate: published,
    score,
    content: `${title}. A fixture report with enough text to be evaluated (${slug}).`,
  };
}

/** Each search call answers with the next list (cycling); records every URL sent to extract. */
export function queryAwareSearch(perQuery: IntakeHit[][]) {
  let call = 0;
  let lists = perQuery;
  const pages = new Map<string, string>();
  const register = (hits: IntakeHit[][]) => hits.flat().forEach((h) => pages.set(h.url, h.content));
  register(perQuery);
  const extractedUrls: string[] = [];
  const client: SearchClient = {
    search: () => {
      const hits = lists[call % Math.max(1, lists.length)] ?? [];
      call += 1;
      return Promise.resolve(hits.map(({ content: _c, ...h }) => h));
    },
    extract: (urls) => {
      extractedUrls.push(...urls);
      return Promise.resolve({
        pages: urls.flatMap((url) =>
          pages.has(url) ? [{ url, title: null, content: pages.get(url)!, images: [] }] : [],
        ),
        failed: urls.filter((u) => !pages.has(u)).map((url) => ({ url, error: 'not in fixture' })),
      });
    },
  };
  return {
    client,
    extractedUrls,
    setLists(next: IntakeHit[][]) {
      lists = next;
      call = 0;
      register(next);
    },
  };
}

export function intakeLlm(options: { failEvaluationFor?: RegExp } = {}) {
  return createScriptedLlm({
    triage: (prompt) => ({
      articles: promptArticles(prompt).map((a) => ({
        ref: a.ref,
        inScope: !/Off-topic/.test(a.headline),
        reason: 'Fixture triage.',
        eventSummary: a.headline,
        eventDate: null,
        entities: [],
        places: [],
        exclusionSignals: [],
      })),
    }),
    cluster: (prompt) => {
      const groups = new Map<string, string[]>();
      for (const a of promptArticles(prompt)) {
        const key = /^(Topic-\w+)/.exec(a.headline)?.[1] ?? a.ref;
        groups.set(key, [...(groups.get(key) ?? []), a.ref]);
      }
      return {
        groups: [...groups.entries()].map(([key, items]) => ({
          items,
          relation: 'new',
          relatedStory: null,
          signature: key,
        })),
      };
    },
    evaluate: (prompt) => {
      const headline = promptArticles(prompt)[0]?.headline ?? 'Fixture';
      if (options.failEvaluationFor?.test(headline))
        throw new LlmError('invalid_request', 'scripted permanent failure', 'gemini');
      return fixtureEvaluation(scores(4), { headline, keyClaims: fixtureKeyClaims(prompt) });
    },
  });
}

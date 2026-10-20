import type { StoryDetailDto } from '@repo/core';
import { plainCheckName, SCORE_THRESHOLDS, type ScoreBand } from '@repo/shared';
import { CircleCheck, CircleSlash, PauseCircle } from 'lucide-react';

import { CONFIDENCE } from './copy';
import { dimensionLabel, dimensionWeight, formatDate } from './format';

/** A score band in words, with its threshold. */
export const BAND: Record<ScoreBand, string> = {
  priority: `A priority: ${SCORE_THRESHOLDS.priority} or above`,
  shortlist: `Meets our standard of ${SCORE_THRESHOLDS.shortlist}`,
  below_threshold: `Below our bar of ${SCORE_THRESHOLDS.shortlist}`,
};

function Dots({ score }: { score: number }) {
  return (
    <span className="flex gap-1" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={i < score ? 'size-2 rounded-full bg-ink' : 'size-2 rounded-full bg-hairline'}
        />
      ))}
    </span>
  );
}

const CHECK = {
  pass: { icon: CircleCheck, className: 'text-moss', label: 'Passed' },
  hold: { icon: PauseCircle, className: 'text-amber', label: 'Needs checking' },
  reject: { icon: CircleSlash, className: 'text-oxide', label: 'Didn’t pass' },
} as const;

/**
 * The full assessment, for editors who want to see the workings: score by dimension, every
 * editorial check, and which model assessed it. Scores guide attention; they never approve.
 */
export function Assessment({
  story,
  summary = true,
}: {
  story: StoryDetailDto;
  /** The total and band; off where a scorecard already shows them. */
  summary?: boolean;
}) {
  const { total, band, confidence } = story.score;
  return (
    <div className="grid gap-10">
      {summary ? (
        <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
          <div>
            <p className="meta">Overall score</p>
            <p className="masthead text-[3.5rem] leading-none tabular-nums">
              {total ?? '—'}
              <span className="font-sans text-base font-normal text-graphite normal-case">
                {' '}
                / 100
              </span>
            </p>
          </div>
          <div className="pb-2">
            {band ? (
              <p className="text-ink">{BAND[band]}</p>
            ) : (
              <p className="text-ink">Not scored yet</p>
            )}
            {confidence ? <p className="meta">{CONFIDENCE[confidence] ?? confidence}</p> : null}
          </div>
        </div>
      ) : null}

      {story.dimensions.length ? (
        <div>
          <h3 className="mb-2 text-[0.84375rem] font-semibold text-ink">How the score was built</h3>
          <ul className="divide-y divide-hairline border-y border-hairline">
            {story.dimensions.map((d) => (
              <li
                key={d.dimension}
                className="grid gap-x-6 gap-y-1 py-3 sm:grid-cols-[13rem_6.5rem_1fr]"
              >
                <div>
                  <p className="text-sm text-ink">{dimensionLabel(d.dimension)}</p>
                  <p className="meta">Counts for {dimensionWeight(d.dimension)}%</p>
                </div>
                <div className="flex items-center gap-2" aria-label={`${d.score} out of 5`}>
                  <Dots score={d.score} />
                  <span className="text-sm text-graphite tabular-nums" aria-hidden>
                    {d.score}/5
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-graphite">{d.rationale}</p>
              </li>
            ))}
          </ul>
          <p className="meta mt-3 max-w-[70ch]">
            The newsroom adds up these weighted scores itself; the AI only scores each part. A score
            decides what deserves attention first. It never approves a story on its own.
          </p>
        </div>
      ) : null}

      <div>
        <h3 className="mb-2.5 text-[0.84375rem] font-semibold text-ink">Editorial checks</h3>
        {story.gates.length ? (
          <ul className="grid gap-3">
            {story.gates.map((g) => {
              const check = CHECK[g.outcome];
              const Icon = check.icon;
              return (
                <li key={g.gate} className="flex gap-3">
                  <Icon className={`mt-0.5 size-4 shrink-0 ${check.className}`} aria-hidden />
                  <div>
                    <p className="text-sm text-ink">
                      {plainCheckName(g.gate)}{' '}
                      <span className="text-graphite">· {check.label}</span>
                    </p>
                    <p className="meta">{g.reason}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="meta">Not checked yet.</p>
        )}
        <p className="meta mt-3 max-w-[70ch]">
          Any check that needs checking or doesn’t pass keeps a story out of the edition, whatever
          its score.
        </p>
      </div>

      <p className="meta border-t border-hairline pt-4">
        Assessed {formatDate(story.evaluation.evaluatedAt)}
        {story.evaluation.model ? ` by ${story.evaluation.model}` : ''}
        {story.evaluation.escalated ? ', with a second, more thorough review' : ''}.
        {story.evaluation.error ? ` Last problem: ${story.evaluation.error}` : ''}
      </p>
    </div>
  );
}

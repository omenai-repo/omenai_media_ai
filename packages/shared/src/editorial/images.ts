/**
 * Story imagery is optional and decorative context: it never influences qualification or
 * ranking, and its rights are always treated as unverified (we only link to the publisher's
 * image; nothing is downloaded or hosted).
 */
export interface ArticleImage {
  url: string;
  alt: string | null;
  pageUrl: string;
  publisher: string;
}

export interface ImageCandidateArticle {
  image: ArticleImage | null | undefined;
  sourceQuality: string;
  extractionStatus: string;
  publishedAt: string | Date | null;
  canonicalUrl: string;
}

const QUALITY_RANK: Record<string, number> = {
  primary: 0,
  reputable_secondary: 1,
  specialist: 2,
  unknown: 3,
  unverified_social: 4,
};

const time = (value: string | Date | null) =>
  value ? new Date(value).getTime() : Number.POSITIVE_INFINITY;

/**
 * Picks one image for a story from its articles, deterministically: an image exists, then the
 * more reliable source, then full text over snippet, then the earliest report, then URL order.
 */
export function selectRepresentativeImage(
  articles: readonly ImageCandidateArticle[],
): ArticleImage | null {
  const withImages = articles.filter((a) => a.image?.url);
  if (withImages.length === 0) return null;
  const [best] = withImages.toSorted(
    (a, b) =>
      (QUALITY_RANK[a.sourceQuality] ?? 3) - (QUALITY_RANK[b.sourceQuality] ?? 3) ||
      Number(b.extractionStatus === 'extracted') - Number(a.extractionStatus === 'extracted') ||
      time(a.publishedAt) - time(b.publishedAt) ||
      a.canonicalUrl.localeCompare(b.canonicalUrl),
  );
  return best?.image ?? null;
}

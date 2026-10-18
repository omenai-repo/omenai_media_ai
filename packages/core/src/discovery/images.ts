/**
 * Chooses an article's preview image from the image URLs Tavily extracted from the page, with
 * deterministic filters and no model call. The result is only a link to the publisher's image:
 * nothing is downloaded or hosted, and rights are always recorded as unverified.
 */
const ALLOWED_EXTENSION = /\.(jpe?g|png|webp|avif)$/i;
const ANY_EXTENSION = /\.[a-z0-9]{2,5}$/i;
const NOT_EDITORIAL =
  /(logo|icon|avatar|sprite|pixel|tracking|badge|placeholder|emoji|banner|\/ads?\/|gravatar|spinner|blank)/i;
const MAX_URL_LENGTH = 2_048;

export function isUsableImageUrl(raw: string): boolean {
  if (raw.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const path = decodeURIComponent(url.pathname).toLowerCase();
  if (NOT_EDITORIAL.test(path)) return false;
  // Extensionless CDN paths are allowed; any other extension must be a photo format.
  return ALLOWED_EXTENSION.test(path) || !ANY_EXTENSION.test(path);
}

/** Alt text for `url` from Markdown image syntax in the extracted page, if present. */
function altFromMarkdown(markdown: string, url: string): string | null {
  for (const match of markdown.matchAll(/!\[([^\]]{1,300})\]\(([^)\s]+)/g)) {
    if (match[2] === url && match[1]?.trim()) return match[1].trim();
  }
  return null;
}

export function pickPreviewImage(
  candidates: readonly string[],
  markdown: string,
): { url: string; alt: string | null } | null {
  const url = candidates.find(isUsableImageUrl);
  return url ? { url, alt: altFromMarkdown(markdown, url) } : null;
}

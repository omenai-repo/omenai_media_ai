import { describe, expect, it } from 'vitest';

import { isUsableImageUrl, pickPreviewImage } from './images.js';

describe('preview image selection', () => {
  it.each([
    ['https://cdn.example/photos/gallery-view.jpg', true],
    ['https://cdn.example/photos/gallery-view.WEBP', true],
    ['https://images.example/abc123?w=1200', true],
    ['http://cdn.example/photo.jpg', false],
    ['https://cdn.example/site-logo.png', false],
    ['https://cdn.example/icons/share.png', false],
    ['https://cdn.example/ads/banner.jpg', false],
    ['https://cdn.example/animation.gif', false],
    ['https://cdn.example/mark.svg', false],
    ['data:image/png;base64,AAAA', false],
    [`https://cdn.example/${'a'.repeat(2_100)}.jpg`, false],
  ])('%s → %s', (url, usable) => {
    expect(isUsableImageUrl(url)).toBe(usable);
  });

  it('takes the first usable candidate and its alt text from the page Markdown', () => {
    const markdown =
      'Intro ![Installation view of Gele at Alexis Galleries](https://cdn.example/gele.jpg) more';
    expect(
      pickPreviewImage(
        [
          'https://cdn.example/logo.png',
          'https://cdn.example/gele.jpg',
          'https://cdn.example/other.jpg',
        ],
        markdown,
      ),
    ).toEqual({
      url: 'https://cdn.example/gele.jpg',
      alt: 'Installation view of Gele at Alexis Galleries',
    });
    expect(pickPreviewImage(['https://cdn.example/other.jpg'], markdown)).toEqual({
      url: 'https://cdn.example/other.jpg',
      alt: null,
    });
    expect(pickPreviewImage([], markdown)).toBeNull();
  });
});

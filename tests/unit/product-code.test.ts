/**
 * Product-code extraction from the seller product edit page.
 *
 * The adapter is pure DOM logic, so the tests exercise `extractProductCode`
 * against a minimal `document` mock (`createTreeWalker` is stubbed because the
 * URL path is covered without ever touching the DOM walker).
 */

import { describe, expect, it } from 'vitest';
import { AliExpressPageAdapter } from '../../src/content/aliexpress-page-adapter';

/** Builds a fake `Document` whose `location` carries the given search string. */
function docWithSearch(search: string): Document {
  return {
    location: { hostname: 'seller.aliexpress.com', pathname: '/publish', search },
  } as unknown as Document;
}

describe('extractProductCode', () => {
  it('reads productId from the URL query', () => {
    const adapter = new AliExpressPageAdapter(docWithSearch('?productId=1000001234567890&foo=bar'));
    expect(adapter.extractProductCode()).toBe('1000001234567890');
  });

  it('reads product_id (snake case key)', () => {
    const adapter = new AliExpressPageAdapter(docWithSearch('?product_id=225580010123456789'));
    expect(adapter.extractProductCode()).toBe('225580010123456789');
  });

  it('reads offerId from the URL query', () => {
    const adapter = new AliExpressPageAdapter(docWithSearch('?offerId=100012345678'));
    expect(adapter.extractProductCode()).toBe('100012345678');
  });

  it('ignores a non-numeric or too-short productId', () => {
    const adapter = new AliExpressPageAdapter(docWithSearch('?productId=abc123'));
    expect(adapter.extractProductCode()).toBeNull();
  });

  it('returns null when no URL key matches and the DOM path is unavailable', () => {
    const adapter = new AliExpressPageAdapter(docWithSearch('?sp=a'));
    expect(adapter.extractProductCode()).toBeNull();
  });
});

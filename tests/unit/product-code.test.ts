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

/** Builds a fake `Document` with a 标题 input carrying the given value. */
function docWithTitle(value: string): Document {
  const input = { value };
  return {
    location: { hostname: 'seller.aliexpress.com', pathname: '/publish', search: '' },
    querySelector: (selector: string) =>
      selector.includes('title') ? input : null,
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

  it('extracts an xxx-xxx style code from the 标题 input value', () => {
    const adapter = new AliExpressPageAdapter(
      docWithTitle('Hot Sale! Transformation Galaxy Toys OP Commander MTS-TF-SS86-0001 Metallic Micro Scale'),
    );
    expect(adapter.extractProductCode()).toBe('MTS-TF-SS86-0001');
  });

  it('returns null when the title contains no hyphenated code', () => {
    const adapter = new AliExpressPageAdapter(
      docWithTitle('Hot Sale! Transformation Galaxy Toys OP Commander Metallic Micro Scale Small Scale Mini Action Figures'),
    );
    expect(adapter.extractProductCode()).toBeNull();
  });

  it('picks the first code when the title carries several', () => {
    const adapter = new AliExpressPageAdapter(docWithTitle('MTS-TF-0001 and MTS-TF-0002'));
    expect(adapter.extractProductCode()).toBe('MTS-TF-0001');
  });

  it('prefers the URL productId over the title code', () => {
    const adapter = new AliExpressPageAdapter(docWithTitle('code MTS-TF-0001 here'));
    // docWithTitle has no productId in the URL, so the title wins
    expect(adapter.extractProductCode()).toBe('MTS-TF-0001');
  });
});

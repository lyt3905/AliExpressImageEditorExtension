/**
 * Product-code extraction from the seller product edit page.
 *
 * The rule is now narrow on purpose: **only a `xxx-xxx` shaped code inside the 标题
 * input counts, and it must contain a digit.** Everything else yields `null` — an
 * absent code simply means no code layer on the canvas, which is fine; a wrong code
 * gets printed onto a 主图 and looks like a defect.
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
function docWithTitle(value: string, search = ''): Document {
  const input = { value };
  return {
    location: { hostname: 'seller.aliexpress.com', pathname: '/publish', search },
    querySelector: (selector: string) => (selector.includes('title') ? input : null),
  } as unknown as Document;
}

describe('extractProductCode — the title code is the only source', () => {
  it('extracts an xxx-xxx style code from the 标题 input value', () => {
    const adapter = new AliExpressPageAdapter(
      docWithTitle('Hot Sale! Transformation Galaxy Toys OP Commander MTS-TF-SS86-0001 Metallic Micro Scale'),
    );
    expect(adapter.extractProductCode()).toBe('MTS-TF-SS86-0001');
  });

  it('picks the first code when the title carries several', () => {
    const adapter = new AliExpressPageAdapter(docWithTitle('MTS-TF-0001 and MTS-TF-0002'));
    expect(adapter.extractProductCode()).toBe('MTS-TF-0001');
  });

  it('skips a hyphenated word in front of the real code', () => {
    // `Pre-order` is a word, not a code: matching it and stopping would drop the code
    // sitting right behind it.
    const adapter = new AliExpressPageAdapter(docWithTitle('Pre-order! MTS-TF-0001 Metallic Figure'));
    expect(adapter.extractProductCode()).toBe('MTS-TF-0001');
  });

  it('returns null when the title has no code at all', () => {
    const adapter = new AliExpressPageAdapter(
      docWithTitle('Hot Sale! Transformation Galaxy Toys OP Commander Metallic Action Figure'),
    );
    expect(adapter.extractProductCode()).toBeNull();
  });

  it('returns null for a hyphenated word with no digit anywhere', () => {
    // The old rule accepted this and stamped `micro-scale` on the main image.
    const adapter = new AliExpressPageAdapter(docWithTitle('High-quality micro-scale pre-order figure'));
    expect(adapter.extractProductCode()).toBeNull();
  });

  it('returns null when there is no 标题 input', () => {
    const adapter = new AliExpressPageAdapter(docWithSearch(''));
    expect(adapter.extractProductCode()).toBeNull();
  });

  it('returns null for an empty title', () => {
    expect(new AliExpressPageAdapter(docWithTitle('   ')).extractProductCode()).toBeNull();
  });
});

describe('extractProductCode — the numeric product id is NOT a code', () => {
  it('ignores the URL productId when the title carries no code', () => {
    // The offer id is a 16-digit Alibaba number; printing it on a 主图 reads as a
    // mistake. Previously this was the fallback and it produced exactly that.
    const adapter = new AliExpressPageAdapter(
      docWithTitle('Plain title without any code', '?productId=1000001234567890'),
    );
    expect(adapter.extractProductCode()).toBeNull();
  });

  it('ignores the URL entirely, even when only the URL could answer', () => {
    for (const search of [
      '?productId=1000001234567890',
      '?product_id=225580010123456789',
      '?offerId=100012345678',
    ]) {
      expect(new AliExpressPageAdapter(docWithSearch(search)).extractProductCode(), search).toBeNull();
    }
  });

  it('still prefers the title code when a URL id is present', () => {
    const adapter = new AliExpressPageAdapter(
      docWithTitle('Hot Sale MTS-TF-SS86-0001 Figures', '?productId=1000001234567890'),
    );
    expect(adapter.extractProductCode()).toBe('MTS-TF-SS86-0001');
  });
});

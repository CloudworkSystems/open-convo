/**
 * Fixed ranks from the visibility report plan. This table is the only
 * place a problem's group, effort and rank are set.
 */

export const CHECKS = Object.freeze([
  'listing-present',
  'listing-details-match',
  'ai-mention',
  'reviews',
  'website-basics',
]);

export const MISMATCH_FIELDS = Object.freeze(['name', 'address', 'phone', 'hours']);

export const RANK_TABLE = Object.freeze([
  Object.freeze({ rank: 1, key: 'hours', problem: 'Listing hours differ from the website', kind: 'listing-details-match', group: 1, effort: 'Quick' }),
  Object.freeze({ rank: 2, key: 'phone', problem: 'Listing phone differs from the website', kind: 'listing-details-match', group: 1, effort: 'Quick' }),
  Object.freeze({ rank: 3, key: 'address', problem: 'Listing address differs from the website', kind: 'listing-details-match', group: 1, effort: 'Medium' }),
  Object.freeze({ rank: 4, key: 'wrong-details', problem: 'An AI assistant gives wrong details', kind: 'ai-mention', group: 1, effort: 'Slow' }),
  Object.freeze({ rank: 5, key: 'no-listing', problem: 'No listing on a named service', kind: 'listing-present', group: 2, effort: 'Medium' }),
  Object.freeze({ rank: 6, key: 'no-website', problem: 'No website', kind: 'website-basics', group: 2, effort: 'Slow' }),
  Object.freeze({ rank: 7, key: 'not-on-phone', problem: 'Website does not work on a phone', kind: 'website-basics', group: 2, effort: 'Slow' }),
  Object.freeze({ rank: 8, key: 'not-mentioned', problem: 'Not mentioned by an AI assistant', kind: 'ai-mention', group: 2, effort: 'Slow' }),
  Object.freeze({ rank: 9, key: 'unanswered', problem: 'Reviews with no reply', kind: 'reviews', group: 3, effort: 'Quick' }),
  Object.freeze({ rank: 10, key: 'no-recent-reviews', problem: 'No reviews in the last 90 days', kind: 'reviews', group: 3, effort: 'Medium' }),
  Object.freeze({ rank: 11, key: 'few-reviews', problem: 'Fewer than 10 reviews', kind: 'reviews', group: 3, effort: 'Medium' }),
  Object.freeze({ rank: 12, key: 'name', problem: 'Listing name written differently', kind: 'listing-details-match', group: 4, effort: 'Quick' }),
  Object.freeze({ rank: 13, key: 'no-title', problem: 'Website has no page title', kind: 'website-basics', group: 4, effort: 'Quick' }),
  Object.freeze({ rank: 14, key: 'no-description', problem: 'Website has no description', kind: 'website-basics', group: 4, effort: 'Quick' }),
  Object.freeze({ rank: 15, key: 'no-contact', problem: 'No visible way to contact', kind: 'website-basics', group: 4, effort: 'Quick' }),
]);

const BY_KEY = new Map(RANK_TABLE.map((row) => [row.key, row]));

export function rankRow(key) {
  return BY_KEY.get(key);
}

function byRank(a, b) {
  return rankRow(a).rank - rankRow(b).rank;
}

/** Problem keys recorded by valid details, lowest rank number first. */
export function problemKeys(check, details) {
  switch (check) {
    case 'listing-present':
      return details.present === false ? ['no-listing'] : [];
    case 'listing-details-match':
      return details.mismatches.map((entry) => entry.field).sort(byRank);
    case 'ai-mention':
      if (details.result === 'wrong-details') return ['wrong-details'];
      if (details.result === 'not-mentioned') return ['not-mentioned'];
      return [];
    case 'reviews': {
      const keys = [];
      if (details.unanswered > 0) keys.push('unanswered');
      if (details.last90Days === 0) keys.push('no-recent-reviews');
      if (details.count < 10) keys.push('few-reviews');
      return keys;
    }
    case 'website-basics': {
      if (details.hasWebsite === false) return ['no-website'];
      const keys = [];
      if (details.worksOnPhone === false) keys.push('not-on-phone');
      if (details.title === false) keys.push('no-title');
      if (details.description === false) keys.push('no-description');
      if (details.contact === false) keys.push('no-contact');
      return keys;
    }
    default:
      return [];
  }
}

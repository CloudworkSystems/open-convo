import { fill } from './text.mjs';

/** Every fixed sentence the renderer can write lives in this module. */

export const SECTION = Object.freeze({
  fix: 'Fix these first',
  also: 'Also found',
  unknown: "Couldn't check",
  working: "What's working",
});

export const STALE_MARK = 'Check again before acting: found';

const NUMBER_WORDS = Object.freeze([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
]);

export const PROBLEM_TEXT = Object.freeze({
  hours: {
    problem: 'Listing hours differ from the website',
    what: 'The {service} listing shows different hours than the website.',
    why: 'Customers may arrive when you are closed or miss you when you are open.',
    do: 'Update the listing hours so they match the website.',
    detail: 'The listing says "{listing}" and the website says "{website}".',
  },
  phone: {
    problem: 'Listing phone differs from the website',
    what: 'The {service} listing shows a different phone number than the website.',
    why: 'Customers may call a number that does not reach the business.',
    do: 'Update the listing phone number so it matches the website.',
    detail: 'The listing says "{listing}" and the website says "{website}".',
  },
  address: {
    problem: 'Listing address differs from the website',
    what: 'The {service} listing shows a different address than the website.',
    why: 'Customers may go to the wrong place.',
    do: 'Update the listing address so it matches the website.',
    detail: 'The listing says "{listing}" and the website says "{website}".',
  },
  name: {
    problem: 'Listing name written differently',
    what: 'The {service} listing writes the name differently than the website.',
    why: 'People may wonder whether it is the same business.',
    do: 'Make the listing name match the website.',
    detail: 'The listing says "{listing}" and the website says "{website}".',
  },
  'wrong-details': {
    problem: 'An AI assistant gives wrong details',
    what: '{assistant} gave wrong details when asked "{question}".',
    why: 'People who ask that assistant may hear something that is not true.',
    do: 'Correct the public details that assistant is repeating.',
    detail: 'What was wrong: {wrongDetails}',
  },
  'no-listing': {
    problem: 'No listing on a named service',
    what: '{service} has no listing for this business.',
    why: 'People who look there cannot find the business.',
    do: 'Create a listing on {service} with the same details as the website.',
  },
  'no-website': {
    problem: 'No website',
    what: 'This business has no website.',
    why: 'People who look for a site of its own cannot find one.',
    do: 'Publish a simple website with the business name, the hours, and a way to get in touch.',
  },
  'not-on-phone': {
    problem: 'Website does not work on a phone',
    what: 'The website does not work on a phone.',
    why: 'Many people will open it on a phone and leave.',
    do: 'Make the pages readable and usable on a phone.',
  },
  'not-mentioned': {
    problem: 'Not mentioned by an AI assistant',
    what: '{assistant} did not mention this business when asked "{question}".',
    why: 'People who ask that assistant do not hear about the business.',
    do: 'Publish clear public pages that answer that question.',
  },
  unanswered: {
    problem: 'Reviews with no reply',
    what: '{unanswered} reviews on {service} have no reply.',
    why: 'A reply shows the business is listening.',
    do: 'Reply to the reviews that have none.',
  },
  'no-recent-reviews': {
    problem: 'No reviews in the last 90 days',
    what: '{service} shows no reviews in the last 90 days.',
    why: 'Recent reviews help people see that the business is still active.',
    do: 'Ask recent customers to leave a review.',
  },
  'few-reviews': {
    problem: 'Fewer than 10 reviews',
    what: '{service} shows {count} reviews, which is fewer than 10.',
    do: 'Ask customers to leave a review until there are at least 10.',
    why: 'A few more reviews give people more to go on.',
  },
  'no-title': {
    problem: 'Website has no page title',
    what: 'The website has no page title.',
    why: 'A title tells people which page this is.',
    do: 'Add a page title with the business name.',
  },
  'no-description': {
    problem: 'Website has no description',
    what: 'The website has no description.',
    why: 'A short description tells people what the business does.',
    do: 'Add a description of the business.',
  },
  'no-contact': {
    problem: 'No visible way to contact',
    what: 'The website has no visible way to get in touch.',
    why: 'A visitor who wants to call or write has no next step.',
    do: 'Show a phone number or a contact form on the page.',
  },
});

export const STATUS_TEXT = Object.freeze({
  'listing-present': {
    ok: '{service} has a listing for this business.',
    unknown: 'Whether {service} has a listing could not be checked.',
  },
  'listing-details-match': {
    ok: 'The {service} listing matches the website.',
    unknown: 'Whether the {service} listing matches the website could not be checked.',
  },
  'ai-mention': {
    ok: '{assistant} mentioned this business when asked "{question}".',
    unknown: 'Whether {assistant} mentions this business when asked "{question}" could not be checked.',
  },
  reviews: {
    ok: '{service} shows {count} reviews, {last90Days} of them in the last 90 days, and every review has a reply.',
    unknown: 'The reviews on {service} could not be checked.',
  },
  'website-basics': {
    ok: 'The website has a page title, a description, a way to get in touch, and it works on a phone.',
    unknown: 'The website basics could not be checked.',
  },
});

const SUMMARY_PIECES = Object.freeze([
  'We found nothing to fix.',
  'We found 1 thing to fix.',
  'We found {count} things to fix.',
  'The first one affects customers right now.',
  'The first {word} affect customers right now.',
  'The first one makes the business harder to find.',
  'The first {word} make the business harder to find.',
  'The first one is a thin sign of recent activity.',
  'The first {word} are thin signs of recent activity.',
  'The first one is a small fix to the public details.',
  'The first {word} are small fixes to the public details.',
  'Some checks could not be finished, and those are listed too.',
  "The checks that finished are listed under What's working.",
  'No checks were recorded in this file.',
  'One more is listed under Also found, and some checks could not be finished.',
  '{count} more are listed under Also found, and some checks could not be finished.',
  'One more is listed under Also found.',
  '{count} more are listed under Also found.',
  'Each one below says what to change.',
  'Listing: {source} ({checkedOn}); website: {website} ({websiteCheckedOn}).',
  '{source}, checked {checkedOn}.',
  `${STALE_MARK} {date}.`,
]);

function countWord(n) {
  return n <= 10 ? NUMBER_WORDS[n] : String(n);
}

function leadSentence(group, count) {
  const word = countWord(count);
  if (group === 1) {
    return count === 1
      ? 'The first one affects customers right now.'
      : `The first ${word} affect customers right now.`;
  }
  if (group === 2) {
    return count === 1
      ? 'The first one makes the business harder to find.'
      : `The first ${word} make the business harder to find.`;
  }
  if (group === 3) {
    return count === 1
      ? 'The first one is a thin sign of recent activity.'
      : `The first ${word} are thin signs of recent activity.`;
  }
  return count === 1
    ? 'The first one is a small fix to the public details.'
    : `The first ${word} are small fixes to the public details.`;
}

export function summarySentences({
  problemCount,
  leadGroup,
  leadCount,
  alsoCount,
  unknownCount,
  workingCount,
}) {
  if (problemCount === 0) {
    const sentences = ['We found nothing to fix.'];
    if (unknownCount > 0) sentences.push('Some checks could not be finished, and those are listed too.');
    else if (workingCount > 0) sentences.push("The checks that finished are listed under What's working.");
    else sentences.push('No checks were recorded in this file.');
    return sentences;
  }

  const sentences = [
    problemCount === 1 ? 'We found 1 thing to fix.' : `We found ${problemCount} things to fix.`,
    leadSentence(leadGroup, leadCount),
  ];
  if (alsoCount > 0 && unknownCount > 0) {
    sentences.push(alsoCount === 1
      ? 'One more is listed under Also found, and some checks could not be finished.'
      : `${alsoCount} more are listed under Also found, and some checks could not be finished.`);
  } else if (alsoCount > 0) {
    sentences.push(alsoCount === 1
      ? 'One more is listed under Also found.'
      : `${alsoCount} more are listed under Also found.`);
  } else if (unknownCount > 0) {
    sentences.push('Some checks could not be finished, and those are listed too.');
  } else {
    sentences.push('Each one below says what to change.');
  }
  return sentences;
}

export function problemCopy(key, vars) {
  const text = PROBLEM_TEXT[key];
  const sentences = [fill(text.what, vars), fill(text.why, vars), fill(text.do, vars)];
  if (text.detail) sentences.push(fill(text.detail, vars));
  return { problem: text.problem, sentences };
}

export function statusCopy(check, status, vars) {
  return fill(STATUS_TEXT[check][status], vars);
}

export function staleSentence(date) {
  return `${STALE_MARK} ${date}.`;
}

/** Every fixed sentence and template, including each summary the rules can build. */
export function fixedWording() {
  const sentences = new Set(SUMMARY_PIECES);
  for (const heading of Object.values(SECTION)) sentences.add(heading);
  for (const text of Object.values(PROBLEM_TEXT)) {
    sentences.add(text.problem);
    sentences.add(text.what);
    sentences.add(text.why);
    sentences.add(text.do);
    if (text.detail) sentences.add(text.detail);
  }
  for (const text of Object.values(STATUS_TEXT)) {
    sentences.add(text.ok);
    sentences.add(text.unknown);
  }
  for (const problemCount of [0, 1, 2, 6, 12]) {
    for (const leadGroup of [1, 2, 3, 4]) {
      for (const leadCount of [1, 2, 6, 12]) {
        for (const alsoCount of [0, 1, 2, 12]) {
          for (const unknownCount of [0, 1]) {
            for (const workingCount of [0, 1]) {
              if (problemCount === 0 && leadCount !== 1) continue;
              for (const sentence of summarySentences({
                problemCount,
                leadGroup: problemCount === 0 ? 0 : leadGroup,
                leadCount: Math.min(leadCount, Math.max(problemCount, 1)),
                alsoCount,
                unknownCount,
                workingCount,
              })) sentences.add(sentence);
            }
          }
        }
      }
    }
  }
  sentences.add(staleSentence('2026-01-02'));
  return [...sentences];
}

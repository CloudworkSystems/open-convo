import { daysBefore, escapeField, formatSource } from './text.mjs';
import {
  SECTION,
  STALE_MARK,
  problemCopy,
  staleSentence,
  statusCopy,
  summarySentences,
} from './wording.mjs';

const MULTILINE = new Set(['listing', 'website', 'wrongDetails']);
const MISMATCH = new Set(['hours', 'phone', 'address', 'name']);

function compareIds(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function rawVars(finding, problem) {
  const { details } = finding;
  const vars = {};
  if (details.service !== undefined) vars.service = details.service;
  if (details.assistant !== undefined) vars.assistant = details.assistant;
  if (details.question !== undefined) vars.question = details.question;
  if (details.count !== undefined) vars.count = details.count;
  if (details.last90Days !== undefined) vars.last90Days = details.last90Days;
  if (details.unanswered !== undefined) vars.unanswered = details.unanswered;
  if (details.wrongDetails !== undefined) vars.wrongDetails = details.wrongDetails;
  if (problem && MISMATCH.has(problem.key)) {
    const match = details.mismatches.find((entry) => entry.field === problem.key);
    vars.listing = match.listing;
    vars.website = match.website;
  }
  return vars;
}

function markdownVars(vars) {
  const escaped = {};
  for (const [key, value] of Object.entries(vars)) {
    escaped[key] = typeof value === 'number'
      ? String(value)
      : escapeField(value, { multiline: MULTILINE.has(key) });
  }
  return escaped;
}

function sourceJson(source) {
  const out = { label: source.label };
  if (source.url) out.url = source.url;
  if (source.locator) out.locator = source.locator;
  return out;
}

function withWebsite(target, finding) {
  if (!finding.websiteSource) return target;
  target.websiteSource = sourceJson(finding.websiteSource);
  target.websiteCheckedOn = finding.websiteCheckedOn;
  return target;
}

function staleDateFor(reportDate, finding) {
  const dates = [finding.checkedOn];
  if (finding.websiteCheckedOn) dates.push(finding.websiteCheckedOn);
  const stale = dates.filter((date) => daysBefore(reportDate, date) > 30);
  if (stale.length === 0) return null;
  stale.sort();
  return stale[0];
}

function whereLine(finding) {
  if (finding.websiteSource) {
    return `Listing: ${formatSource(finding.source)} (${finding.checkedOn}); website: ${formatSource(finding.websiteSource)} (${finding.websiteCheckedOn}).`;
  }
  return `${formatSource(finding.source)}, checked ${finding.checkedOn}.`;
}

function renderList(groups) {
  return groups.map((lines, index) => {
    const marker = `${index + 1}. `;
    const pad = ' '.repeat(marker.length);
    const physical = lines.join('\n').split('\n');
    return physical.map((line, lineIndex) => (lineIndex === 0 ? marker : pad) + line).join('\n');
  }).join('\n\n');
}

function section(heading, groups) {
  if (groups.length === 0) return '';
  return `## ${heading}\n\n${renderList(groups)}`;
}

function problemJson(finding, position) {
  return finding.problems.map((row) => {
    const copy = problemCopy(row.key, rawVars(finding, row));
    return withWebsite({
      rank: row.rank,
      group: row.group,
      effort: row.effort,
      position,
      problem: copy.problem,
      sentences: copy.sentences,
      source: sourceJson(finding.source),
      checkedOn: finding.checkedOn,
    }, finding);
  });
}

function rankedJson(finding) {
  return withWebsite({
    id: finding.id,
    position: finding.position,
    rank: finding.rank,
    group: finding.group,
    effort: finding.effort,
    check: finding.check,
    stale: finding.staleDate !== null,
    checkAgain: finding.staleDate ? staleSentence(finding.staleDate) : null,
    problems: problemJson(finding, finding.position),
    source: sourceJson(finding.source),
    checkedOn: finding.checkedOn,
  }, finding);
}

function infoJson(finding) {
  return withWebsite({
    id: finding.id,
    check: finding.check,
    status: finding.status,
    sentences: [statusCopy(finding.check, finding.status, rawVars(finding))],
    source: sourceJson(finding.source),
    checkedOn: finding.checkedOn,
  }, finding);
}

function rankedLines(finding) {
  const lines = [];
  for (const row of finding.problems) {
    lines.push(...problemCopy(row.key, markdownVars(rawVars(finding, row))).sentences);
  }
  if (finding.staleDate) lines.push(`${STALE_MARK} *${finding.staleDate}*.`);
  lines.push(whereLine(finding));
  return lines;
}

function infoLines(finding) {
  return [
    statusCopy(finding.check, finding.status, markdownVars(rawVars(finding))),
    whereLine(finding),
  ];
}

export function renderReport(doc) {
  const ranked = doc.findings
    .filter((finding) => finding.status === 'problem')
    .map((finding) => {
      const top = finding.problems[0];
      return {
        ...finding,
        rank: top.rank,
        group: top.group,
        effort: top.effort,
        staleDate: staleDateFor(doc.reportDate, finding),
      };
    })
    .sort((a, b) => a.rank - b.rank || compareIds(a.id, b.id))
    .map((finding, index) => ({ ...finding, position: index + 1 }));

  const byId = (a, b) => compareIds(a.id, b.id);
  const unknown = doc.findings.filter((finding) => finding.status === 'unknown').sort(byId);
  const working = doc.findings.filter((finding) => finding.status === 'ok').sort(byId);
  const fixList = ranked.slice(0, 5);
  const alsoFound = ranked.slice(5);

  let leadCount = 0;
  if (ranked.length > 0) {
    const splitAt = ranked.findIndex((finding) => finding.group !== ranked[0].group);
    leadCount = splitAt === -1 ? ranked.length : splitAt;
  }

  const summary = summarySentences({
    problemCount: ranked.length,
    leadGroup: ranked[0]?.group ?? 0,
    leadCount,
    alsoCount: alsoFound.length,
    unknownCount: unknown.length,
    workingCount: working.length,
  });

  const business = { name: doc.business.name };
  if (doc.business.siteUrl) business.siteUrl = doc.business.siteUrl;

  const json = {
    schemaVersion: 1,
    business,
    reportDate: doc.reportDate,
    summary,
    fixList: fixList.map(rankedJson),
    alsoFound: alsoFound.map(rankedJson),
    couldntCheck: unknown.map(infoJson),
    working: working.map(infoJson),
  };

  const blocks = [
    `# ${escapeField(doc.business.name)} — ${doc.reportDate}`,
    '',
    summary.join(' '),
    '',
  ];
  for (const block of [
    section(SECTION.fix, fixList.map(rankedLines)),
    section(SECTION.also, alsoFound.map(rankedLines)),
    section(SECTION.unknown, unknown.map(infoLines)),
    section(SECTION.working, working.map(infoLines)),
  ]) {
    if (!block) continue;
    blocks.push(block, '');
  }

  return {
    markdown: `${blocks.join('\n').replace(/\n+$/, '\n')}`,
    jsonText: `${JSON.stringify(json, null, 2)}\n`,
    json,
  };
}

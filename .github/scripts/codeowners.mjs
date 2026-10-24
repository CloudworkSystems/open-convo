// Reads the simple CODEOWNERS patterns this repo uses and tells which changed
// files need the owner. Supports what the file uses: leading-slash anchored
// paths, directories ending in "/", and "*" inside a file name.

export function parseCodeowners(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/);
      return { pattern, owners };
    })
    .filter((rule) => rule.owners.length > 0);
}

function toRegExp(pattern) {
  const anchored = pattern.startsWith('/');
  let body = pattern.replace(/^\//, '');
  const directory = body.endsWith('/');
  body = body
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  const prefix = anchored ? '^' : '(^|.*/)';
  return new RegExp(`${prefix}${body}${directory ? '.*' : '(/.*)?$'}`);
}

export function protectedFiles(rules, files) {
  const compiled = rules.map((rule) => ({ ...rule, regex: toRegExp(rule.pattern) }));
  return files.filter((file) => {
    // Last matching rule wins, as in GitHub.
    let owners = null;
    for (const rule of compiled) if (rule.regex.test(file)) owners = rule.owners;
    return owners !== null && owners.length > 0;
  });
}

// GitHub skips the code-owner review when the code owner opened the pull
// request (docs/plans/merge-gate.md, scratch test 3), so a protected file
// changed in a pull request opened from the owner's account would need no
// approval at all. Returns why such a pull request must wait, or null.
// `files` lists each changed path, and a renamed file's old path too.
export function ownerOpenedBlock({ prAuthor, files = [], rules = [] }) {
  const owned = rules.some((rule) => rule.owners.some((o) => o.replace(/^@/, '') === prAuthor));
  if (!prAuthor || !owned) return null;
  const hit = protectedFiles(rules, files);
  if (hit.length === 0) return null;
  return `Opened from the code owner's account and changes ${hit[0]}; reopen it from cloudwork-bot`;
}

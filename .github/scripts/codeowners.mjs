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

const FORBIDDEN_BUILTINS = new Set([
  "child_process",
  "dgram",
  "dns",
  "fs",
  "http",
  "https",
  "net"
]);

export async function resolve(specifier, context, nextResolve) {
  const withoutNodePrefix = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const rootName = withoutNodePrefix.split("/", 1)[0];
  if (FORBIDDEN_BUILTINS.has(rootName)) {
    throw new Error(`test blocked ${specifier}`);
  }
  return nextResolve(specifier, context);
}

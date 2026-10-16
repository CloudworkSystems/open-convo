// Escaping is per destination. Facts are plain text and may contain
// "&", quotes, "<", ">" or "</script>".

export function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function escapeAttr(value) {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// JSON-LD sits inside a script element. "<" is escaped so the block cannot
// close itself. "&" and ">" are escaped the same way; the result still parses.
export function jsonForScript(value) {
  return JSON.stringify(value, null, 2)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

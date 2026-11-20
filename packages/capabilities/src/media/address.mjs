// Only a loopback HTTP origin. Names such as localhost are refused here,
// before any DNS lookup or connection. 127.0.0.1 and ::1 are the only
// addresses the plan allows.

const LOOPBACK = new Set(['127.0.0.1', '::1']);

/**
 * @param {unknown} input
 * @returns {{ hostname: '127.0.0.1' | '::1', port: number, family: 4 | 6 } | null}
 */
export function parseServer(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 200) return null;
  if (/\s/.test(input)) return null;
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.search || url.hash) return null;
  let hostname = url.hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (!LOOPBACK.has(hostname)) return null;
  const portText = url.port;
  if (portText !== '' && !/^[1-9]\d{0,4}$/.test(portText)) return null;
  const port = portText === '' ? 80 : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname, port, family: hostname === '::1' ? 6 : 4 };
}

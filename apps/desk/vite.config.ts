import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev refresh and CSS injection need a nonce; production has external assets.
// A fresh value is generated per server/build process, never a stored secret.
const nonce = randomBytes(24).toString('base64');
const appRoot = fileURLToPath(new URL('.', import.meta.url));
const cloudPreview = process.env.DESK_CLOUD_PREVIEW === '1';

function allowPreviewAnnotationStyles(html: string): string {
  const policies = [...html.matchAll(/<meta\b[^>]*\shttp-equiv\s*=\s*"Content-Security-Policy"[^>]*>/gi)];
  if (policies.length !== 1) throw new Error('Hosted annotation styles require exactly one CSP meta element.');
  const tag = policies[0][0];
  const contents = [...tag.matchAll(/\scontent\s*=\s*"([^"]*)"/gi)];
  if (contents.length !== 1) throw new Error('Hosted annotation styles require exactly one CSP content attribute.');
  const policy = contents[0][1];
  const directives = new Map<string, string>();
  for (const clause of policy.split(';').map((value) => value.trim()).filter(Boolean)) {
    const [rawName, ...sources] = clause.split(/\s+/);
    const name = rawName.toLowerCase();
    if (directives.has(name)) throw new Error('Hosted annotation styles require an unambiguous CSP.');
    directives.set(name, sources.join(' '));
  }
  if (directives.get('style-src') !== "'self'" || directives.has('style-src-elem') || directives.has('style-src-attr')) {
    throw new Error('Hosted annotation styles require the reviewed baseline stylesheet policy.');
  }
  // An owner native-browser report identified a blocked inline style element.
  // Permit those elements only in the hosted preview, keeping attributes and
  // every existing script/network/resource restriction in place. A nonce in
  // this directive would disable unsafe-inline for the browser's injected CSS.
  const updated = `${policy.trim().replace(/;\s*$/, '')}; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'none'`;
  return html.replace(tag, tag.replace(contents[0][0], ` content="${updated}"`));
}

export default defineConfig(({ command, mode }) => {
  const nativeProof = mode === 'native-proof';
  if (nativeProof && cloudPreview) throw new Error('Native proof and hosted preview builds must be prepared separately.');
  // A development server must not require Git metadata or acquire the hosted
  // policy merely because the preview build flag is inherited.
  const previewBuild = cloudPreview && command === 'build' ? {
    application: 'true-convo-desk-preview',
    protocol: 1,
    source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8' }).trim(),
    version: JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string,
    working_copy: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: appRoot, encoding: 'utf8' }).trim()),
  } : null;
  return ({
  base: nativeProof ? './' : '/',
  define: { __DESK_PREVIEW_BUILD__: JSON.stringify(previewBuild) },
  plugins: [
    react(),
    {
      name: 'desk-cloud-preview-build',
      generateBundle() {
        if (previewBuild) {
          this.emitFile({ type: 'asset', fileName: 'desk-build.json', source: JSON.stringify(previewBuild) });
        }
      },
      transformIndexHtml(html) {
        if (!previewBuild) return html;
        const identified = html.replace(/<title>.*?<\/title>/, `<title>True Convo Desk · ${previewBuild.version} · ${previewBuild.source_commit.slice(0, 8)}</title>`);
        return command === 'build' ? allowPreviewAnnotationStyles(identified) : identified;
      },
    },
    {
      name: 'desk-font-licenses',
      generateBundle() {
        for (const name of ['OFL-atkinsonhyperlegiblenext.txt', 'OFL-jetbrainsmono.txt']) {
          this.emitFile({ type: 'asset', fileName: `licenses/${name}`, source: readFileSync(new URL(`./brand/fonts/${name}`, import.meta.url), 'utf8') });
        }
        this.emitFile({ type: 'asset', fileName: 'licenses/ISC-lucide.txt', source: readFileSync(new URL('./src/ui/lucide/LICENSE', import.meta.url), 'utf8') });
      },
    },
    {
      name: 'desk-development-csp',
      transformIndexHtml(html, context) {
        if (command !== 'serve') return html;
        const address = context.server?.httpServer?.address();
        const port = address && typeof address === 'object' ? address.port : context.server?.config.server.port;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error('Development CSP needs the running loopback server port.');
        }
        const sockets = ['127.0.0.1', 'localhost'].map((host) => `ws://${host}:${port}`).join(' ');
        return html
          .replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`)
          .replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`)
          .replace("connect-src 'self'", `connect-src 'self' ${sockets}`);
      },
    },
  ],
  html: { cspNonce: nonce },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    fs: {
      strict: true,
      // Do not inherit access to a surrounding workspace or neighboring repos.
      allow: [appRoot],
      deny: [
        // Preserve Vite 8's defaults before adding the product's private paths.
        '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc', '.yarnrc.yml', '**/.git/**',
        '**/.true-convo-local/**', '**/runtime-state/**', '**/auth.json',
        '**/*.{key,p12,p8,mobileprovision,cer}',
      ],
    },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { outDir: nativeProof ? 'native-dist' : 'dist', sourcemap: false, assetsInlineLimit: 0 },
  });
});

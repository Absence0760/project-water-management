#!/usr/bin/env node
// Guard for the split Content-Security-Policy (infra/security_headers.tf).
//
// The CloudFront header allows `script-src 'self' 'unsafe-inline'` because the
// SvelteKit bootstrap script's hash changes every build. What makes the
// effective policy strict is SvelteKit's own <meta http-equiv=
// "content-security-policy"> (kit.csp.mode = 'hash'), which the browser
// enforces on top of the header. If that meta tag ever disappears, the site
// silently falls back to 'unsafe-inline'. This script refuses that build.
//
// For every .html file under the build directory it checks that:
//   - there is a meta CSP whose script-src lists a sha256 hash for EVERY
//     inline <script>, and allows neither 'unsafe-inline' nor 'unsafe-eval';
//   - no element carries an inline event-handler attribute (onclick=…),
//     which no hash-based script-src would allow anyway.
//
// Usage: node infra/scripts/check-csp.mjs [frontend/build]
// Exit code 1 on any violation. Run by .github/workflows/deploy-frontend.yml
// between the build and the S3 sync.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] ?? 'frontend/build';

function htmlFiles(dir) {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) return htmlFiles(p);
		return name.endsWith('.html') ? [p] : [];
	});
}

const sha256 = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

export function checkHtml(html) {
	const errors = [];

	// Only executable inline scripts: no src, and no non-JS type (JSON data
	// blocks don't run and don't need a hash).
	const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
		.filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs))
		.filter(([, attrs]) => {
			const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
			return !type || type === 'module' || type === 'text/javascript';
		})
		.map(([, , body]) => body);

	const meta = /<meta\b[^>]*http-equiv\s*=\s*["']content-security-policy["'][^>]*>/i.exec(html)?.[0];
	const content = meta && /\bcontent\s*=\s*"([^"]*)"/i.exec(meta)?.[1];

	if (!content) {
		if (inline.length) errors.push(`${inline.length} inline script(s) but no <meta http-equiv="content-security-policy"> (set kit.csp.mode = 'hash' in frontend/svelte.config.js)`);
	} else {
		const scriptSrc = content
			.split(';')
			.map((d) => d.trim().split(/\s+/))
			.find(([name]) => name === 'script-src');
		if (!scriptSrc) {
			errors.push('meta CSP has no script-src directive');
		} else {
			const sources = new Set(scriptSrc.slice(1));
			for (const bad of ["'unsafe-inline'", "'unsafe-eval'"]) {
				if (sources.has(bad)) errors.push(`meta CSP script-src allows ${bad}`);
			}
			for (const body of inline) {
				const h = sha256(body);
				if (!sources.has(h)) errors.push(`inline script ${h} is not in the meta CSP script-src`);
			}
		}
	}

	const handler = /<[a-z][^>]*\s(on[a-z]+)\s*=/i.exec(html);
	if (handler) errors.push(`inline event handler attribute ${handler[1]}= (blocked by CSP)`);

	return { errors, inlineScripts: inline.length };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	const files = htmlFiles(root);
	if (!files.length) {
		console.error(`check-csp: no .html files under ${root} — build first.`);
		process.exit(1);
	}
	let failed = false;
	for (const file of files) {
		const { errors, inlineScripts } = checkHtml(readFileSync(file, 'utf8'));
		const name = relative(process.cwd(), file);
		if (errors.length) {
			failed = true;
			console.error(`check-csp: ${name}\n  ${errors.join('\n  ')}`);
		} else {
			console.log(`check-csp: ${name} OK (${inlineScripts} inline script(s), all hashed in the meta CSP)`);
		}
	}
	process.exit(failed ? 1 : 0);
}

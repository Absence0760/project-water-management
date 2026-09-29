// Serves the e2e frontend build the way CloudFront serves production. Every
// request goes through CloudFront's own spa_rewrite function, loaded from
// infra/s3_cloudfront.tf (infra/scripts/cloudfront-functions.mjs), so the two
// can't drift: an extension-less path gets index.html (the SPA fallback), the
// prerendered pages their own HTML, a build file the file, and a path with an
// extension outside the build's file locations the function's 404 page. What
// the function forwards and the build doesn't have gets a plain 404, as S3
// answers a missing key. Dependency-free on purpose. Tests: site.test.ts.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { loadFunction } from '../../infra/scripts/cloudfront-functions.mjs';

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain; charset=utf-8',
	'.webmanifest': 'application/manifest+json'
};

/** The build file at an S3 key (the URI spa_rewrite forwards), or null when there is none. */
async function fileAt(root: string, uri: string): Promise<string | null> {
	let key: string;
	try {
		key = decodeURIComponent(uri);
	} catch {
		return null;
	}
	const path = normalize(join(root, key));
	if (!path.startsWith(root + sep)) return null;
	try {
		return (await stat(path)).isFile() ? path : null;
	} catch {
		return null;
	}
}

/** An HTTP server for the build in `dir`, routed by CloudFront's spa_rewrite. Call listen() on it. */
export function createSiteServer(dir: string): Server {
	const root = resolve(dir);
	const spa = loadFunction('spa_rewrite');
	return createServer(async (req, res) => {
		const { pathname } = new URL(req.url ?? '/', 'http://localhost');
		const out = spa.handler({
			request: { method: req.method ?? 'GET', uri: pathname, querystring: {}, headers: {}, cookies: {} },
			viewer: { ip: req.socket.remoteAddress ?? '127.0.0.1' }
		});
		if ('statusCode' in out) {
			const headers = Object.fromEntries(Object.entries(out.headers ?? {}).map(([k, v]) => [k, v.value]));
			res.writeHead(out.statusCode, headers).end(out.body?.data ?? '');
			return;
		}
		const path = await fileAt(root, out.uri);
		if (!path) {
			res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
			return;
		}
		res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
		createReadStream(path).pipe(res);
	});
}

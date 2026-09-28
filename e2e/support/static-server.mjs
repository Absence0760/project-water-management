// Serves the e2e frontend build the way CloudFront serves production: files
// as they are, and index.html (the SPA fallback) for any path that isn't a
// file. Dependency-free on purpose. Usage: node static-server.mjs <dir> <port>
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const [dirArg, portArg] = process.argv.slice(2);
if (!dirArg || !portArg) {
	console.error('usage: node static-server.mjs <dir> <port>');
	process.exit(2);
}
const root = resolve(dirArg);
const port = Number(portArg);

const TYPES = {
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

async function fileAt(pathname) {
	const path = normalize(join(root, decodeURIComponent(pathname)));
	if (path !== root && !path.startsWith(root + sep)) return null;
	try {
		const s = await stat(path);
		if (s.isFile()) return path;
		if (s.isDirectory()) {
			const index = join(path, 'index.html');
			if ((await stat(index)).isFile()) return index;
		}
	} catch {
		// Not a file: fall through to the SPA fallback.
	}
	return null;
}

// The prerendered pages, served for their extension-less path, as CloudFront's
// spa_rewrite function does (infra/s3_cloudfront.tf): the landing page (issue #57) and the legal pages.
const PRERENDERED = { '/welcome': '/welcome.html', '/privacy': '/privacy.html', '/terms': '/terms.html' };

createServer(async (req, res) => {
	const { pathname } = new URL(req.url ?? '/', 'http://localhost');
	let path;
	try {
		path = (await fileAt(PRERENDERED[pathname] ?? pathname)) ?? join(root, 'index.html');
	} catch {
		res.writeHead(400).end();
		return;
	}
	res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
	createReadStream(path).pipe(res);
}).listen(port, 'localhost', () => console.log(`e2e site: http://localhost:${port} (${root})`));

// The e2e site server's command line (playwright.config.ts starts it); the
// routing is site.ts. Usage: node support/static-server.ts <dir> <port>
import { resolve } from 'node:path';
import { createSiteServer } from './site.ts';

const [dir, port] = process.argv.slice(2);
if (!dir || !port) {
	console.error('usage: node static-server.ts <dir> <port>');
	process.exit(2);
}
createSiteServer(dir).listen(Number(port), 'localhost', () => console.log(`e2e site: http://localhost:${port} (${resolve(dir)})`));

// Writes src/liability/limitations.generated.ts from docs/engine-audit.md
// (roadmap WP-3.13). Run `pnpm gen:limitations` after changing an audit
// item's decision; src/liability/limitations.test.ts fails until you do.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderLimitationsModule } from '../src/liability/generate';
import { parseAuditLimitations } from '../src/liability/limitations';

const doc = fileURLToPath(new URL('../../../docs/engine-audit.md', import.meta.url));
const out = fileURLToPath(new URL('../src/liability/limitations.generated.ts', import.meta.url));
const list = parseAuditLimitations(readFileSync(doc, 'utf8'));
writeFileSync(out, renderLimitationsModule(list));
console.log(`${list.length} open audit items → src/liability/limitations.generated.ts`);

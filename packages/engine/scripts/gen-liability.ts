// Writes the generated liability modules (roadmap WP-3.13) from their docs:
//   docs/engine-audit.md     → src/liability/limitations.generated.ts
//   docs/engine-errata.md    → src/liability/errata.generated.ts
//   docs/methodology/v<N>.md → src/liability/methodology.generated.ts
//                              and methodology-text.generated.ts
// Run `pnpm gen:liability` after changing any of them; the matching tests
// (limitations, errata, methodology) fail until you do.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseErrata } from '../src/liability/errata';
import { renderErrataModule, renderLimitationsModule, renderMethodologyModule, renderMethodologyTextModule } from '../src/liability/generate';
import { parseAuditLimitations } from '../src/liability/limitations';
import { readMethodologyVersions } from './methodologyFiles';

const docs = (p: string) => fileURLToPath(new URL(`../../../docs/${p}`, import.meta.url));
const src = (p: string) => fileURLToPath(new URL(`../src/liability/${p}`, import.meta.url));

const limitations = parseAuditLimitations(readFileSync(docs('engine-audit.md'), 'utf8'));
writeFileSync(src('limitations.generated.ts'), renderLimitationsModule(limitations));
console.log(`${limitations.length} open audit items → src/liability/limitations.generated.ts`);

const errata = parseErrata(readFileSync(docs('engine-errata.md'), 'utf8'));
writeFileSync(src('errata.generated.ts'), renderErrataModule(errata));
console.log(`${errata.length} errata → src/liability/errata.generated.ts`);

const { versions, currentText } = readMethodologyVersions(docs('methodology'));
const current = versions[versions.length - 1]!;
writeFileSync(src('methodology.generated.ts'), renderMethodologyModule(versions));
writeFileSync(src('methodology-text.generated.ts'), renderMethodologyTextModule(current, currentText));
console.log(`${versions.length} methodology version(s), current ${current.version} → src/liability/methodology*.generated.ts`);

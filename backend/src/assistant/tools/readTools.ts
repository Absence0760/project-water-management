// The assistant's read-only project tools (issue #610). Each reads through
// the run routes' own readers (runs/read.ts), so what a member is kept from
// there (registered volumes and the series worked out from them, #523 I, D3)
// is kept from the assistant too, inside the orchestrator's
// withUser(…, { readOnly: true }) transaction. None sends a member's or a
// farmer's name or email.
import type { AssistantTool } from '../types.js';
import { gaugeFitTool } from './gaugeFit.js';
import { networkTool } from './network.js';
import { runSummaryTool } from './runSummary.js';
import { searchHelpTool } from './searchHelp.js';
import { seriesTool } from './series.js';
import { settingsTool } from './settings.js';

export const READ_TOOLS: readonly AssistantTool[] = [runSummaryTool, settingsTool, networkTool, seriesTool, gaugeFitTool, searchHelpTool];

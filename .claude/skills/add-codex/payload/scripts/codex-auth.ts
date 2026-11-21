/**
 * Codex sign-in from the host, outside the setup flow.
 *
 *   pnpm exec tsx scripts/codex-auth.ts --reauth [--method browser|device]
 *
 * replaces the stored ChatGPT login in the selected gateway under the same
 * id, so agent grants survive. With no arguments it runs the setup auth step.
 */
import { runCodexAuthCli } from '../setup/providers/codex.js';

runCodexAuthCli(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Codex authentication failed');
  process.exitCode = 1;
});

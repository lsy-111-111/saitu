import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Node normally resolves the main module's symlinks, but retains the original
 * CLI argument. Compare canonical paths so deployment's current symlink still
 * executes main, while ordinary imports and node --eval stay inert. */
export function isDirectExecution(moduleUrl, entrypoint = process.argv[1]) {
  if (!entrypoint) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entrypoint);
  } catch { return false; }
}

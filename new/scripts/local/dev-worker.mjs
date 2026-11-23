import { installSourceLoader } from '../lib/load-typescript-source.mjs';
import { ROOT } from './shared.mjs';
installSourceLoader(ROOT);
await import('../competitions/v7/worker-entry.ts');

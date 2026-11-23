import nextEnv from '@next/env';
import { environment } from './shared.mjs';
const overlay = await environment(process.env.SAITU_LOCAL_PROCESS_MODE === 'development' ? 'development' : 'production');
Object.assign(process.env, overlay);
nextEnv.updateInitialEnv(overlay);

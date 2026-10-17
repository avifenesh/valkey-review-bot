import { bootstrap } from '../../common/src/run-agent.js';
import { assembleTools } from './tools/index.js';

await bootstrap({ assembleTools });

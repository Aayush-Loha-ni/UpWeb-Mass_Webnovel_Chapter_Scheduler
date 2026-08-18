import * as path from 'path';
import { fileURLToPath } from 'url';

const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
process.env.WORKSPACE_ROOT ??= path.resolve(_dirname, '..', 'data');
process.env.SHARED_DIR ??= path.resolve(_dirname, '..', 'shared');

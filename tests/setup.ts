import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = path.join(os.tmpdir(), `upweb-test-novels-${process.pid}.yaml`);
if (!process.env.NOVELS_REGISTRY_FILE) {
  process.env.NOVELS_REGISTRY_FILE = tmp;
}
fs.writeFileSync(tmp, 'novels: []\n', 'utf8');

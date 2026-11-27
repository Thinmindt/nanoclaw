/**
 * The config-snapshot timer's entry: `node dist/config-snapshot/main.js <gateway url> <out dir>`, run
 * from the project root (the add-config-snapshot skill's service unit). A refused or failed run exits
 * non-zero and writes nothing.
 */
import os from 'os';
import path from 'path';

import { writeSnapshot } from './snapshot.js';

const [gatewayUrl, outDir] = process.argv.slice(2) as [string, string];

const dated = await writeSnapshot(
  {
    dbPath: path.resolve('data', 'v2.db'),
    allowlistPath: path.join(os.homedir(), '.config', 'nanoclaw', 'mount-allowlist.json'),
    gatewayUrl,
    pinPath: path.resolve('.claude', 'skills', 'add-onecli', 'versions.json'),
    projectRoot: path.resolve('.'),
    outDir,
  },
  new Date(),
);
console.log(`config snapshot written: ${dated}`);

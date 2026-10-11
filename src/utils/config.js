import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FLOW_HOME = path.resolve(__dirname, '..', '..');

const configPath = path.join(FLOW_HOME, 'config', 'flow.config.json');
let config;

try {
  const raw = fs.readFileSync(configPath, 'utf-8');
  config = JSON.parse(raw);
} catch (err) {
  console.error(`[CONFIG] Failed to load config from ${configPath}: ${err.message}`);
  config = {};
}

if (config.imageModels) {
  delete config.imageModels['Imagen 4'];
  delete config.imageModels['Nano Banana 2'];
  config.imageModels['Nano Banana 2.1'] = 'nano-banana-2-1';
  config.imageModels['Nano Banana 2 Lite'] = 'nano-banana-2-lite';
}


export default config;

export function get(key, fallback = undefined) {
  return config[key] !== undefined ? config[key] : fallback;
}

// Only an ABSOLUTE flowHome is honored. A relative one (the config used to
// carry "." ) resolves against the MCP *client's* cwd, not this repo — and the
// server is registered under more than one project scope with no cwd set, so
// outputs/, config/flow.projects.json and selectors.map.json silently forked
// into per-client copies. That is how outputs/metadata ended up holding 164
// file references of which zero existed. Relative values are ignored rather
// than honored, so every path built on this is stable regardless of where the
// client was started.
export function getFlowHome() {
  const configured = config.flowHome;
  if (configured && path.isAbsolute(configured)) return configured;
  return FLOW_HOME;
}

// Persists a shallow-merged patch into config/flow.config.json, backing up
// the previous version first (flow.config.json.bak, one level — overwritten
// each call, not a history). Used to self-register newly-discovered
// profiles so the config file stays the single source of truth without
// ever requiring manual editing.
//
// Re-reads the file from disk rather than writing the in-memory `config`
// object back out — this module applies runtime-only patches to it at
// import time (see the imageModels tweak above), which must never get
// silently baked into the actual file on disk.
export function updateConfig(patch) {
  let onDisk;
  try {
    onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.error(`[CONFIG] Failed to re-read config before update, aborting write: ${err.message}`);
    return;
  }
  const merged = { ...onDisk, ...patch };
  try {
    fs.copyFileSync(configPath, `${configPath}.bak`);
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
  } catch (err) {
    console.error(`[CONFIG] Failed to persist config to ${configPath}: ${err.message}`);
    return;
  }
  Object.assign(config, patch);
}

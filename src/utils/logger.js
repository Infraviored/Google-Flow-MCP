import fs from 'fs';
import path from 'path';

let logStream = null;
const LOG_DIR = path.resolve(import.meta.dirname, '../../logs');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogStream() {
  if (!logStream) {
    ensureLogDir();
    const logFile = path.join(LOG_DIR, `flow-${new Date().toISOString().slice(0, 10)}.log`);
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  }
  return logStream;
}

function timestamp() {
  return new Date().toISOString();
}

// Everything goes to stderr, never stdout. This process speaks JSON-RPC over
// stdout — a stray log line there is a malformed message on the wire, and the
// only reason it has not broken outright is that clients tend to skip lines
// they cannot parse. console.log/console.debug write to stdout; console.error
// and console.warn write to stderr, which is why the two below are used
// throughout even for non-error levels.
export const logger = {
  info(msg, data = {}) {
    const line = `[${timestamp()}] INFO  ${msg} ${Object.keys(data).length ? JSON.stringify(data) : ''}`;
    console.error(line);
    getLogStream().write(line + '\n');
  },

  warn(msg, data = {}) {
    const line = `[${timestamp()}] WARN  ${msg} ${Object.keys(data).length ? JSON.stringify(data) : ''}`;
    console.warn(line);
    getLogStream().write(line + '\n');
  },

  error(msg, data = {}) {
    const line = `[${timestamp()}] ERROR ${msg} ${Object.keys(data).length ? JSON.stringify(data) : ''}`;
    console.error(line);
    getLogStream().write(line + '\n');
  },

  debug(msg, data = {}) {
    const line = `[${timestamp()}] DEBUG ${msg} ${Object.keys(data).length ? JSON.stringify(data) : ''}`;
    if (process.env.DEBUG) {
      console.error(line);
    }
    getLogStream().write(line + '\n');
  }
};

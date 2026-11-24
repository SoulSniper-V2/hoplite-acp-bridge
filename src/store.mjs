// Small on-disk state: the model catalogue, known projects and session aliases. No credentials.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function dataDir() {
  const dir =
    process.env.HOPLITE_BRIDGE_HOME ??
    path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "hoplite-acp-bridge");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function log(message) {
  process.stderr.write(`[hoplite-acp-bridge] ${message}\n`);
}

const file = () => path.join(dataDir(), "state.json");
const MAX_SESSIONS = 1000;

export function readState() {
  try {
    return { projects: {}, sessions: {}, unavailable: {}, ...JSON.parse(fs.readFileSync(file(), "utf8")) };
  } catch {
    return { projects: {}, sessions: {}, unavailable: {} };
  }
}

/** Read-modify-write with an atomic rename; several bridge processes can share the file. */
export function updateState(change) {
  try {
    const state = readState();
    change(state);
    const ids = Object.keys(state.sessions);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete state.sessions[id];
    const temp = `${file()}.${process.pid}.${Date.now()}`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, file());
  } catch (error) {
    log(`could not save state: ${error.message}`);
  }
}

/** A directory that is in no repository. */
export function neutralDir() {
  const dir = path.join(dataDir(), "run");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

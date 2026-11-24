// Finds (or downloads) the Hoplite CLI and runs `hoplite acp`.
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Rpc, RpcError } from "./rpc.mjs";
import { dataDir, log } from "./store.mjs";

const execute = promisify(execFile);
// Some Hoplite commands read piped stdin to its end, so it is closed at once.
const run = (...args) => {
  const running = execute(...args);
  running.child.stdin?.end();
  return running;
};
const DOWNLOADS = "https://hoplite.sh/downloads";

const isExecutable = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

export function findHoplite(env = process.env) {
  if (env.HOPLITE_BIN) return isExecutable(env.HOPLITE_BIN) ? env.HOPLITE_BIN : undefined;
  const dirs = [
    ...(env.PATH ?? "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".local", "bin"),
    path.join(dataDir(), "cli"),
  ];
  return dirs.filter(Boolean).map((dir) => path.join(dir, "hoplite")).find(isExecutable);
}

let installing;
export function ensureHoplite() {
  const found = findHoplite();
  if (found) return Promise.resolve(found);
  if (process.env.HOPLITE_BIN) {
    return Promise.reject(new RpcError({ message: `HOPLITE_BIN is not an executable file: ${process.env.HOPLITE_BIN}` }));
  }
  return (installing ??= installHoplite().finally(() => (installing = undefined)));
}

/** Installs the official release into the bridge's own folder, after checking its SHA-256. */
export async function installHoplite() {
  const platform = { darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { arm64: "arm64", x64: "amd64" }[process.arch];
  if (!platform || !arch) {
    throw new RpcError({ message: "Hoplite has no CLI download for this system. Install it and set HOPLITE_BIN." });
  }
  const get = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new RpcError({ message: `Could not download Hoplite (${response.status} from ${url}).` });
    return response;
  };
  const latest = await (await get(`${DOWNLOADS}/latest.json`)).json();
  const version = String(latest.version ?? latest.latest ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new RpcError({ message: "Could not read Hoplite's latest version." });
  const name = `hoplite_${version}_${platform}_${arch}.tar.gz`;
  const base = `${DOWNLOADS}/releases/${version}`;
  log(`downloading Hoplite CLI ${version}`);
  const sums = await (await get(`${base}/checksums.txt`)).text();
  const expected = sums.split("\n").map((line) => line.trim().split(/\s+/)).find(([, file]) => file === name)?.[0];
  const archive = Buffer.from(await (await get(`${base}/${name}`)).arrayBuffer());
  const actual = createHash("sha256").update(archive).digest("hex");
  if (!expected || expected !== actual) throw new RpcError({ message: "The Hoplite download failed its checksum; nothing was installed." });
  const target = path.join(dataDir(), "cli");
  const staging = fs.mkdtempSync(path.join(dataDir(), "cli-"));
  try {
    const file = path.join(staging, name);
    fs.writeFileSync(file, archive);
    await run("tar", ["-xzf", file, "-C", staging]);
    fs.rmSync(file);
    if (!isExecutable(path.join(staging, "hoplite"))) throw new RpcError({ message: "The Hoplite download has an unexpected layout." });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return path.join(target, "hoplite");
}

/** True when the CLI holds a usable key. Never opens a browser. */
export async function isSignedIn(binary) {
  try {
    await run(binary, ["auth", "status"], { timeout: 15_000 });
    return true;
  } catch (error) {
    // Only a definite "no credentials" counts; a network problem must not look like signed out.
    return !/not authenticated|not signed in|invalid|revoked|expired/i.test(`${error.stdout ?? ""}${error.stderr ?? ""}`);
  }
}

export class Upstream {
  constructor({ binary, cwd, args = [], onMessage, onExit, onStderr }) {
    this.child = spawn(binary, ["acp", ...args], { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.child.stdin.on("error", () => {});
    this.rpc = new Rpc({
      input: this.child.stdout,
      output: this.child.stdin,
      idPrefix: "hb-",
      onMessage,
      onBadLine: (line) => log(`unparsed output from hoplite: ${line.slice(0, 200)}`),
    });
    this.child.stderr.on("data", (data) => {
      for (const line of String(data).split("\n").map((l) => l.trim()).filter(Boolean)) {
        log(`hoplite: ${line}`);
        onStderr?.(line);
      }
    });
    const ended = (reason) => {
      if (this.ended) return;
      this.ended = true;
      this.rpc.close(new RpcError({ code: -32603, message: `The Hoplite CLI stopped (${reason}). Send the message again to reconnect.` }));
      onExit?.(this);
    };
    this.child.on("error", (error) => ended(error.message));
    this.child.on("exit", (code, signal) => ended(signal ?? `exit ${code}`));
  }
  stop() {
    if (this.ended) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

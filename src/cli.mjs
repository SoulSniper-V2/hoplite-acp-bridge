import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Bridge, VERSION } from "./bridge.mjs";
import { ensureHoplite, findHoplite, isSignedIn } from "./hoplite.mjs";
import { dataDir, readState } from "./store.mjs";

const HELP = `hoplite-acp-bridge ${VERSION}
Runs Hoplite's cloud agents in T3 Code and other ACP clients.

  hoplite-acp-bridge                Serve ACP on stdin and stdout (what T3 Code runs)
  hoplite-acp-bridge setup [dir…]   Install Hoplite if needed, sign in, and load your models
  hoplite-acp-bridge doctor         Check the installation
  hoplite-acp-bridge --version

Options
  --project <id>                    Use this Hoplite project for every session

Environment
  HOPLITE_BIN             Path to the hoplite command (default: found on PATH, else downloaded)
  HOPLITE_BRIDGE_MCP      off | read (default) | agents | write: the client tools Hoplite may use by default
  HOPLITE_BRIDGE_HOME     Where the bridge keeps its state
`;

export function main(args) {
  if (args.includes("--version") || args.includes("-v")) return void console.log(VERSION);
  if (args.includes("--help") || args.includes("-h")) return void console.log(HELP);
  if (args[0] === "setup") return void setup(args.slice(1)).catch(fail);
  if (args[0] === "doctor") return void doctor().catch(fail);
  serve(args);
}

function fail(error) {
  console.error(error.message);
  process.exitCode = 1;
}

function serve(args) {
  const bridge = new Bridge({ input: process.stdin, output: process.stdout, args: args.filter((arg) => arg !== "acp") });
  bridge.onStop = () => setTimeout(() => process.exit(0), 500).unref();
  process.stdout.on("error", () => bridge.stop());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => bridge.stop());
}

/** Repositories worth asking Hoplite about: the given folders, or the ones near the home folder. */
function candidates(dirs) {
  if (dirs.length > 0) return dirs.map((dir) => path.resolve(dir));
  const found = new Map();
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ".git")) {
      try {
        const remote = /url = .*github\.com[:/](\S+?)(?:\.git)?\s/i.exec(fs.readFileSync(path.join(dir, ".git", "config"), "utf8"))?.[1];
        if (remote && !found.has(remote.toLowerCase())) found.set(remote.toLowerCase(), dir);
      } catch {}
      return;
    }
    if (depth === 0) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !["Library", "node_modules", "Applications"].includes(entry.name)) {
        visit(path.join(dir, entry.name), depth - 1);
      }
    }
  };
  visit(process.cwd(), 0);
  visit(os.homedir(), 2);
  return [...found.values()];
}

async function setup(dirs) {
  const before = findHoplite();
  const binary = await ensureHoplite();
  console.log(`Hoplite CLI   ${binary}${before ? "" : " (just installed)"}`);
  if (!(await isSignedIn(binary))) {
    console.log("Sign-in       opening your browser…");
    await new Promise((resolve, reject) => {
      spawn(binary, ["login"], { stdio: "inherit" }).on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Sign-in did not finish."))));
    });
  }
  console.log("Sign-in       ok");
  const { PassThrough } = await import("node:stream");
  const output = new PassThrough();
  const answers = new Map();
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.method === undefined) answers.get(message.id)?.(message);
    }
  });
  const bridge = new Bridge({ input: new PassThrough(), output });
  bridge.initialize({ protocolVersion: 1 });
  for (const dir of candidates(dirs)) {
    await bridge.handle("session/new", { cwd: dir, mcpServers: [] }).catch((error) => console.error(`${dir}: ${error.message}`));
  }
  bridge.stop();
  const { projects, catalog } = readState();
  for (const project of Object.values(projects)) console.log(`Project       ${project.name}`);
  if (Object.keys(projects).length === 0) console.log("Project       none found; link a repository at https://app.hoplite.sh and run this again");
  if (catalog) console.log(`Models        ${catalog.configOptions.find((option) => option.id === "model")?.options.length ?? 0}`);
  const command = path.resolve(fileURLToPath(import.meta.url), "../../bin/hoplite-acp-bridge.mjs");
  console.log(`\nIn T3 Code: Settings → Providers → Add provider → Show more → Local ACP command\n  Executable   ${installedCommand() ?? command}\n  Name         Hoplite`);
}

function installedCommand() {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => path.join(dir, "hoplite-acp-bridge"))
    .find((file) => fs.existsSync(file));
}

async function doctor() {
  const binary = findHoplite();
  const { projects, catalog } = readState();
  console.log(`Bridge        ${VERSION} (Node ${process.version})`);
  console.log(`Hoplite CLI   ${binary ?? "not found; it is downloaded on first use"}`);
  if (binary) console.log(`Signed in     ${(await isSignedIn(binary)) ? "yes" : "no; run hoplite-acp-bridge setup"}`);
  console.log(`Projects      ${Object.values(projects).map((project) => project.name).join(", ") || "none seen yet"}`);
  console.log(`Models        ${catalog ? `${catalog.configOptions.find((option) => option.id === "model")?.options.length} cached` : "none cached yet"}`);
  console.log(`State         ${dataDir()}`);
}

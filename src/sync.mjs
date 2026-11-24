// Moves changes between a thread's sandbox and the local checkout, with git on both sides.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { ensureHoplite } from "./hoplite.mjs";
import { RpcError } from "./rpc.mjs";

const execute = promisify(execFile);
/** Some Hoplite commands read piped stdin to its end, so it is closed unless there is input. */
export const run = (file, args, { input, ...options } = {}) => {
  const running = execute(file, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  running.child.stdin?.on("error", () => {});
  running.child.stdin?.end(input);
  return running;
};

// Hoplite takes 512 KiB of standard input.
const MAX_STDIN = 380_000;
const HASH = /^[0-9a-f]{40,64}$/;
const problem = (message) => new RpcError({ message });

// A scratch index covers new files without touching the agent's own index.
const CAPTURE = [
  'export GIT_INDEX_FILE="$(mktemp -u)"',
  "git read-tree HEAD",
  "git add -A",
  "tree=$(git write-tree)",
  'rm -f "$GIT_INDEX_FILE"',
  "unset GIT_INDEX_FILE",
].join("\n");

/** Shell that sets $base: the state the local checkout already has, else where the thread branched. */
function baseOf(session) {
  const branch = session.project?.defaultBranch ?? "main";
  if (!/^[\w./-]+$/.test(branch)) throw problem(`Cannot compare with the branch ${branch}.`);
  const own = `base=$(git merge-base HEAD 'origin/${branch}' 2>/dev/null || git rev-parse HEAD)`;
  const saved = session.baseline;
  return HASH.test(saved ?? "") ? `if git cat-file -e '${saved}^{tree}' 2>/dev/null; then base=${saved}; else ${own}; fi` : own;
}

/** Runs a script in the sandbox. Its output is base64 of gzip, so any bytes survive the trip. */
export async function inSandbox(session, script, stdin) {
  const result = await session.connection.rpc.request(
    "_hoplite/sandbox/exec",
    { sessionId: session.upstreamId, command: `set -eo pipefail\n{\n${script}\n} | gzip -c | base64`, timeoutSeconds: 120, ...(stdin ? { stdin: stdin.toString("base64") } : {}) },
    150_000,
  );
  if (result.truncated?.stdout || result.outputIncomplete?.includes("stdout")) {
    throw problem("The sandbox's changes are too large to send back. Use /pr and check out its branch instead.");
  }
  if (result.exitCode !== 0) throw problem(`Git failed in the sandbox: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  return gunzipSync(Buffer.from(result.stdout, "base64"), { maxOutputLength: 64 * 1024 * 1024 });
}

/** The local checkout's root, after checking that it is the thread's repository. */
export async function localRoot(session) {
  let root;
  let remotes;
  try {
    root = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: session.cwd })).stdout.trim();
    remotes = (await run("git", ["remote", "-v"], { cwd: root })).stdout;
  } catch {
    throw problem(`${session.cwd} is not a git checkout.`);
  }
  const repo = session.project?.repo;
  const matches = (remote) => new RegExp(`[:/]${repo.replace(/[^\w/-]/g, "\\$&")}(\\.git)?/?$`, "i").test(remote);
  if (repo && !remotes.split("\n").some((line) => matches(line.split(/\s+/)[1] ?? ""))) {
    throw problem(`${root} is not a checkout of ${repo}, so nothing was changed.`);
  }
  return root;
}

/** Runs git commands on a scratch index, leaving the checkout's own index alone. */
async function scratch(root, work) {
  const index = path.join(os.tmpdir(), `hoplite-bridge-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    return await work(async (args, input) => (await run("git", args, { cwd: root, env, input })).stdout.trim());
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** The working tree as one hash, untracked files included, next to HEAD's. */
export const localTrees = (root) =>
  scratch(root, async (git) => {
    await git(["read-tree", "HEAD"]);
    await git(["add", "-A"]);
    return { tree: await git(["write-tree"]), head: await git(["rev-parse", "HEAD^{tree}"]) };
  });

/** The local state the sandbox already has: what was last sent or pulled, else the last commit. */
async function syncedTree(session, root, head) {
  if (!HASH.test(session.synced ?? "")) return head;
  return run("git", ["cat-file", "-e", `${session.synced}^{tree}`], { cwd: root }).then(() => session.synced, () => head);
}

/** Applies what the sandbox changed since the last sync. All or nothing; returns the file count. */
export async function pull(session) {
  const root = await localRoot(session);
  const output = await inSandbox(
    session,
    [baseOf(session), CAPTURE, "echo $tree", 'git --no-pager diff --binary --no-color --no-ext-diff "$base" "$tree"'].join("\n"),
  );
  const line = output.indexOf(10);
  const tree = output.subarray(0, line).toString();
  if (!HASH.test(tree)) throw problem("The sandbox's answer could not be read.");
  const patch = output.subarray(line + 1);
  if (patch.length > 0) {
    const apply = (args) =>
      run("git", ["apply", "--whitespace=nowarn", ...args, "-"], { cwd: root, input: patch }).catch((error) => {
        throw problem(`The sandbox's changes conflict with your checkout, or are already in it.\n${String(error.stderr ?? "").trim() || error.message}`);
      });
    await apply(["--check"]);
    const { head } = await localTrees(root);
    const before = await syncedTree(session, root, head);
    await apply([]);
    // So the next push sends the person's own changes and not these.
    session.synced = await scratch(root, async (git) => {
      await git(["read-tree", before]);
      await git(["apply", "--cached", "--whitespace=nowarn", "-"], patch);
      return git(["write-tree"]);
    }).catch(() => undefined);
  }
  session.baseline = tree;
  return { root, files: patch.toString("latin1").match(/^diff --git /gm)?.length ?? 0 };
}

// Never sent, as in `hoplite push`.
const CREDENTIALS = [".env", ".env.*", "*.pem", "*.ppk", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "credentials.json", "service-account*.json", "secrets.*", ".dev.vars", ".git-credentials", ".pypirc", ".htpasswd", ".npmrc", ".netrc", "local.settings.json", "*.tfvars", "*.tfstate", "kubeconfig"]
  .map((name) => `:(exclude,glob,icase)**/${name}`)
  .concat([":(exclude,glob,icase)**/secrets/**", ":(exclude,glob)**/.docker/config.json", ":(exclude,glob)**/.kube/config"]);

/** Sends local changes the sandbox doesn't have. They then don't count as its own in the next pull. */
export async function push(session) {
  const root = await localRoot(session);
  const { tree, head } = await localTrees(root);
  const from = await syncedTree(session, root, head);
  const { stdout: patch } = await run("git", ["diff", "--binary", "--no-color", "--no-ext-diff", from, tree, "--", ".", ...CREDENTIALS], { cwd: root, encoding: "buffer" });
  if (patch.length === 0) {
    session.synced = tree;
    return { files: 0 };
  }
  const packed = gzipSync(patch);
  const sent = packed.length < MAX_STDIN && (await pushPatch(session, packed));
  if (!sent) await pushWithHoplite(session);
  session.synced = tree;
  const { stdout: names } = await run("git", ["diff", "--name-only", from, tree, "--", ".", ...CREDENTIALS], { cwd: root });
  session.sentFiles = [...new Set([...(session.sentFiles ?? []), ...names.trim().split("\n")])];
  return { files: names.trim().split("\n").length };
}

/** Applies a patch to the sandbox's files. False when it doesn't fit them. */
async function pushPatch(session, packed) {
  const script = [
    'patch="$(mktemp)"',
    'gzip -dc > "$patch"',
    baseOf(session),
    'if ! git apply --check --whitespace=nowarn "$patch" 2>/dev/null; then echo refused; else',
    'git apply --whitespace=nowarn "$patch"',
    'export GIT_INDEX_FILE="$(mktemp -u)"',
    'git read-tree "$base"',
    // Without it the next pull may report these changes as a conflict, and change nothing.
    'if git apply --cached --3way --whitespace=nowarn "$patch" >/dev/null 2>&1; then git write-tree; else echo unknown; fi',
    'rm -f "$GIT_INDEX_FILE"',
    "fi",
    'rm -f "$patch"',
  ].join("\n");
  const answer = (await inSandbox(session, script, packed)).toString().trim();
  if (answer === "refused") return false;
  if (HASH.test(answer)) session.baseline = answer;
  return true;
}

/** Hoplite's own push merges three ways, but only uncommitted changes, and it stages what it writes. */
async function pushWithHoplite(session) {
  const before = (await inSandbox(session, `${baseOf(session)}\n${CAPTURE}\necho $base $tree $(git diff --cached --quiet && echo clean || echo staged)`)).toString().trim().split(" ");
  await run(await ensureHoplite(), ["push", "--thread", session.upstreamId], { cwd: session.cwd, timeout: 120_000 }).catch((error) => {
    throw problem(`${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message);
  });
  const [base, tree, index] = before;
  if (!HASH.test(base) || !HASH.test(tree)) return;
  const script = [
    ...(index === "clean" ? ["git reset -q"] : []),
    CAPTURE,
    `if [ "$tree" = ${tree} ]; then git rev-parse '${base}^{tree}'; else`,
    'export GIT_INDEX_FILE="$(mktemp -u)"',
    `git read-tree ${base}`,
    `git --no-pager diff --binary --no-ext-diff ${tree} "$tree" | git apply --cached --3way --whitespace=nowarn - >&2`,
    "git write-tree",
    'rm -f "$GIT_INDEX_FILE"',
    "fi",
  ].join("\n");
  const next = await inSandbox(session, script).then((bytes) => bytes.toString().trim(), () => "");
  if (HASH.test(next)) session.baseline = next;
}

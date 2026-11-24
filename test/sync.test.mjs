// Two clones of one repository stand in for the sandbox and the local checkout.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { localRoot, localTrees, pull, push } from "../src/sync.mjs";

let dir;
let sandbox;
let local;
let session;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (root, name, text) => fs.writeFileSync(path.join(root, name), text);
const read = (name) => fs.readFileSync(path.join(local, name), "utf8");

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sync-")));
  const origin = path.join(dir, "acme", "app.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  for (const name of ["sandbox", "local"]) git(dir, "clone", "-q", origin, name);
  [sandbox, local] = ["sandbox", "local"].map((name) => path.join(dir, name));
  for (const root of [sandbox, local]) {
    git(root, "config", "user.email", "t@example.test");
    git(root, "config", "user.name", "t");
    git(root, "checkout", "-q", "-B", "main");
  }
  write(sandbox, "a.txt", "one\ntwo\nthree\n");
  git(sandbox, "add", "-A");
  git(sandbox, "commit", "-qm", "base");
  git(sandbox, "push", "-q", "origin", "main");
  git(local, "pull", "-q", "origin", "main");
  session = {
    cwd: local,
    upstreamId: "thr_1",
    project: { repo: "acme/app", defaultBranch: "main" },
    connection: {
      rpc: {
        request: async (method, { command, stdin }) => {
          assert.equal(method, "_hoplite/sandbox/exec");
          const { status, stdout, stderr } = spawnSync("bash", ["-c", command], { cwd: sandbox, encoding: "utf8", input: Buffer.from(stdin ?? "", "base64") });
          return { exitCode: status, stdout, stderr, truncated: {} };
        },
      },
    },
  };
  // A stand-in for `hoplite push`: applies the local diff in the sandbox.
  const bin = path.join(dir, "hoplite");
  fs.writeFileSync(bin, `#!/bin/sh\ncd '${local}' && git add -AN && git diff --binary HEAD | (cd '${sandbox}' && git apply --3way -) && echo pushed\n`, { mode: 0o755 });
  process.env.HOPLITE_BIN = bin;
});
afterEach(() => {
  delete process.env.HOPLITE_BIN;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pulls edits, new, deleted and binary files, commits included, and commits nothing", async () => {
  write(sandbox, "b.txt", "committed\n");
  git(sandbox, "add", "-A");
  git(sandbox, "commit", "-qm", "agent");
  write(sandbox, "a.txt", "ONE\ntwo\nthree\n");
  fs.writeFileSync(path.join(sandbox, "c.bin"), Buffer.from([0, 255, 128, 10, 13, 0]));
  assert.equal((await pull(session)).files, 3);
  assert.equal(read("a.txt"), "ONE\ntwo\nthree\n");
  assert.equal(read("b.txt"), "committed\n");
  assert.deepEqual([...fs.readFileSync(path.join(local, "c.bin"))], [0, 255, 128, 10, 13, 0]);
  assert.equal(git(local, "log", "--oneline").split("\n").length, 1);
  assert.match(git(sandbox, "status", "--short"), /^M a\.txt\n\?\? c\.bin$|^ ?M a\.txt/);
});

test("each pull applies only what is new", async () => {
  write(sandbox, "a.txt", "ONE\ntwo\nthree\n");
  assert.equal((await pull(session)).files, 1);
  assert.equal((await pull(session)).files, 0);
  write(sandbox, "a.txt", "ONE\ntwo\nTHREE\n");
  assert.equal((await pull(session)).files, 1);
  assert.equal(read("a.txt"), "ONE\ntwo\nTHREE\n");
});

test("a conflict changes nothing and stays to be pulled", async () => {
  write(sandbox, "a.txt", "agent\n");
  write(sandbox, "new.txt", "x\n");
  write(local, "a.txt", "mine\n");
  await assert.rejects(pull(session), /conflict with your checkout/);
  assert.equal(read("a.txt"), "mine\n");
  assert.ok(!fs.existsSync(path.join(local, "new.txt")));
  git(local, "checkout", "-q", "a.txt");
  assert.equal((await pull(session)).files, 2);
});

test("pushed changes don't come back, and unpulled ones aren't lost", async () => {
  write(sandbox, "agent.txt", "from agent\n");
  write(local, "mine.txt", "from me\n");
  assert.equal((await push(session)).files, 1);
  assert.equal(git(sandbox, "diff", "--cached", "--name-only"), "");
  assert.equal(fs.readFileSync(path.join(sandbox, "mine.txt"), "utf8"), "from me\n");
  assert.equal((await pull(session)).files, 1);
  assert.equal(read("agent.txt"), "from agent\n");
  assert.equal(read("mine.txt"), "from me\n");
});

test("falls back when the sandbox no longer has the last synced state", async () => {
  session.baseline = "0".repeat(40);
  write(sandbox, "b.txt", "x\n");
  assert.equal((await pull(session)).files, 1);
});

test("refuses another repository's checkout", async () => {
  for (const repo of ["acme/other", "cme/app", "acme/ap"]) {
    session.project.repo = repo;
    await assert.rejects(pull(session), /is not a checkout of/);
  }
  session.project.repo = "ACME/app";
  assert.equal(await localRoot(session), local);
  session.cwd = os.tmpdir();
  await assert.rejects(pull(session), /not a git checkout/);
});

test("cannot write outside the checkout", async () => {
  session.connection.rpc.request = async () => {
    const { gzipSync } = await import("node:zlib");
    const patch = "diff --git a/../evil b/../evil\nnew file mode 100644\n--- /dev/null\n+++ b/../evil\n@@ -0,0 +1 @@\n+x\n";
    return { exitCode: 0, stdout: gzipSync(`${"a".repeat(40)}\n${patch}`).toString("base64"), stderr: "", truncated: {} };
  };
  await assert.rejects(pull(session));
  assert.ok(!fs.existsSync(path.join(dir, "evil")));
});

test("both sides can keep editing the same file", async () => {
  for (const turn of ["1", "2", "3"]) {
    write(local, "a.txt", `${read("a.txt")}me ${turn}\n`);
    assert.equal((await push(session)).files, 1);
    assert.equal((await push(session)).files, 0);
    fs.appendFileSync(path.join(sandbox, "a.txt"), `agent ${turn}\n`);
    assert.equal((await pull(session)).files, 1);
    assert.equal((await pull(session)).files, 0);
    // A restart keeps only these.
    session = { ...session, baseline: session.baseline, synced: session.synced };
  }
  assert.equal(read("a.txt"), fs.readFileSync(path.join(sandbox, "a.txt"), "utf8"));
  assert.match(read("a.txt"), /me 3\nagent 3\n$/);
  assert.equal(git(local, "diff", "--cached", "--name-only"), "");
});

test("a patch that doesn't fit falls back to Hoplite's own push", async () => {
  write(sandbox, "a.txt", "one\ntwo\nthree\nfour\n");
  write(local, "a.txt", "ONE\ntwo\nthree\n");
  session.synced = undefined;
  const { request } = session.connection.rpc;
  session.connection.rpc.request = async (method, params) => (params.stdin ? { exitCode: 0, stdout: execFileSync("sh", ["-c", "echo refused | gzip -c | base64"], { encoding: "utf8" }), stderr: "", truncated: {} } : request(method, params));
  git(sandbox, "checkout", "-q", "a.txt");
  assert.equal((await push(session)).files, 1);
  assert.equal(fs.readFileSync(path.join(sandbox, "a.txt"), "utf8"), "ONE\ntwo\nthree\n");
  assert.equal(git(sandbox, "diff", "--cached", "--name-only"), "");
  assert.equal((await pull(session)).files, 0);
});

test("never sends credential files", async () => {
  for (const name of [".env", ".env.local", "server.pem", "id_rsa", ".npmrc"]) write(local, name, "secret");
  fs.mkdirSync(path.join(local, "x", "secrets"), { recursive: true });
  write(local, "x/secrets/key.txt", "secret");
  write(local, "x/.env", "secret");
  write(local, "fine.txt", "ok");
  assert.equal((await push(session)).files, 1);
  assert.equal(git(sandbox, "status", "--short"), "?? fine.txt");
});

test("leaves the checkout's index alone", async () => {
  const before = await localTrees(local);
  assert.equal(before.tree, before.head);
  write(local, "n.txt", "x");
  assert.notEqual((await localTrees(local)).tree, before.tree);
  assert.equal(git(local, "status", "--short"), "?? n.txt");
});

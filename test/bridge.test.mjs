// Drives the bridge over ACP against a scripted stand-in for `hoplite acp`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { Bridge, answerText, readableTitle } from "../src/bridge.mjs";
import { Rpc, RpcError } from "../src/rpc.mjs";
import { readState, updateState } from "../src/store.mjs";

const PROJECT = { id: "proj_1", name: "acme/app", repo: "acme/app", defaultBranch: "main" };
const options = (model = "opus") => [
  { type: "select", id: "model", name: "Model", currentValue: model, options: ["opus", "haiku"].map((value) => ({ value, name: value })) },
  { type: "select", id: "reasoning", name: "Reasoning", currentValue: "medium", options: ["low", "medium"].map((value) => ({ value, name: value })) },
];

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  process.env.HOPLITE_BRIDGE_HOME = home;
  delete process.env.HOPLITE_BRIDGE_MCP;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** `handlers` answer upstream methods; everything sent upstream is recorded in `sent`. */
function start({ handlers = {}, signedIn = true } = {}) {
  const sent = [];
  const updates = [];
  const upstreams = [];
  let nextId = 0;
  const spawnUpstream = async (project, { onMessage }) => {
    const toHoplite = new PassThrough();
    const toBridge = new PassThrough();
    const rpc = new Rpc({ input: toBridge, output: toHoplite, idPrefix: "hb-", onMessage });
    const upstream = { project, rpc, ended: false, stop: () => (upstream.ended = true) };
    const server = new Rpc({
      input: toHoplite,
      output: toBridge,
      idPrefix: "s-",
      onMessage: async ({ id, method, params }) => {
        sent.push({ project, method, params });
        if (id === undefined) return;
        try {
          const result = await (handlers[method] ?? defaults[method] ?? (() => ({})))(params, server, project);
          server.send({ id, result });
        } catch (error) {
          server.send({ id, error: { code: error.code ?? -32603, message: error.message, data: error.data } });
        }
      },
    });
    upstream.server = server;
    upstreams.push(upstream);
    return upstream;
  };
  const defaults = {
    "session/new": () => ({ sessionId: `thr_${++nextId}`, configOptions: options(), _meta: { hoplite: { project: PROJECT } } }),
    "session/load": () => ({ configOptions: options(), _meta: { hoplite: { project: PROJECT } } }),
    "session/set_config_option": ({ value }) => ({ configOptions: options(value) }),
    "session/prompt": () => ({ stopReason: "end_turn" }),
  };
  const input = new PassThrough();
  const output = new PassThrough();
  const requests = [];
  let onRequest = () => ({});
  const client = new Rpc({
    input: output,
    output: input,
    idPrefix: "c-",
    onMessage: async (message) => {
      if (message.method === "session/update") updates.push(message.params.update);
      else if (message.id !== undefined) {
        requests.push(message);
        client.send({ id: message.id, result: await onRequest(message) });
      }
    },
  });
  const bridge = new Bridge({ input, output, cwd: "/work", spawnUpstream, checkSignedIn: async () => signedIn });
  return {
    bridge,
    client,
    sent,
    updates,
    upstreams,
    requests,
    onRequest: (answer) => (onRequest = answer),
    prompts: () => sent.filter(({ method }) => method === "session/prompt"),
    say: (sessionId, text) => client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
    open: async (capabilities = {}) => {
      await client.request("initialize", { protocolVersion: 2, clientCapabilities: capabilities });
      return (await client.request("session/new", { cwd: "/work", mcpServers: [] })).sessionId;
    },
  };
}

const noProject = () => {
  throw new RpcError({ message: "No Hoplite project matches this directory." });
};
const gate = () => {
  let open;
  const closed = new Promise((resolve) => (open = resolve));
  return { open, closed };
};
const soon = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test("answers protocol 1 to a client that opens with 2, with resume and images", async () => {
  const { client } = start();
  const result = await client.request("initialize", { protocolVersion: 2 });
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.agentCapabilities.loadSession, true);
  assert.equal(result.agentCapabilities.promptCapabilities.image, true);
});

test("a signed-out session asks for sign-in without starting Hoplite", async () => {
  const { open, upstreams } = start({ signedIn: false });
  await assert.rejects(open(), { code: -32000 });
  assert.equal(upstreams.length, 0);
});

test("lists each model's own reasoning levels", async () => {
  const { client } = start();
  await client.request("initialize", { protocolVersion: 2 });
  const { models } = await client.request("session/new", { cwd: "/work", mcpServers: [] });
  assert.deepEqual(models.availableModels.map(({ modelId }) => modelId), ["opus", "haiku"]);
  assert.deepEqual(models.availableModels[0]._meta.reasoningEfforts.map(({ value }) => value), ["low", "medium"]);
});

test("an unlinked folder still opens, and says why it cannot run", async () => {
  const { open, say } = start({ handlers: { "session/new": noProject } });
  const id = await open();
  assert.match(id, /^hbs_/);
  await assert.rejects(say(id, "hi"), /not linked to a Hoplite project/);
});

test("a fallback project applies only to an unlinked folder", async () => {
  updateState((state) => (state.projects[PROJECT.id] = { name: PROJECT.name }));
  const choose = (bridge, sessionId) => bridge.client.request("session/set_config_option", { sessionId, configId: "hoplite_fallback_project", value: PROJECT.id });

  const linked = start();
  const linkedId = await linked.open();
  await choose(linked, linkedId);
  await linked.say(linkedId, "hi");
  assert.ok(linked.prompts().every(({ project }) => project === ""));

  const unlinked = start({ handlers: { "session/new": (_params, _server, project) => (project ? { sessionId: "thr_f", configOptions: options(), _meta: { hoplite: { project: PROJECT } } } : noProject()) } });
  const unlinkedId = await unlinked.open();
  await choose(unlinked, unlinkedId);
  await unlinked.say(unlinkedId, "hi");
  assert.deepEqual(unlinked.prompts().map(({ project }) => project), [PROJECT.id]);
  assert.equal(readState().sessions[unlinkedId].upstreamId, "thr_f");
});

test("a failed run reports its reason instead of a refusal", async () => {
  const failure = { code: "usage_limit", title: "Out of credits", message: "Add credits.", actions: [{ label: "Billing", url: "https://example.test" }] };
  const { open, say } = start({ handlers: { "session/prompt": () => ({ stopReason: "refusal", _meta: { hoplite: { failure } } }) } });
  await assert.rejects(say(await open(), "hi"), { code: -32603, message: "Out of credits: Add credits.\nBilling: https://example.test" });
});

test("missing credits are not shown as signed out", async () => {
  const { open, say } = start({
    handlers: {
      "session/prompt": () => {
        throw new RpcError({ code: -32000, message: "Insufficient credits", data: { code: "insufficient_credits" } });
      },
    },
  });
  await assert.rejects(say(await open(), "hi"), { code: -32603, message: "Insufficient credits" });
});

test("retries Hoplite's internal error under one message id", async () => {
  let attempts = 0;
  const { open, say, prompts } = start({
    handlers: {
      "session/prompt": () => {
        if (++attempts === 1) throw new RpcError({ code: -32603, message: "Internal error" });
        return { stopReason: "end_turn" };
      },
    },
  });
  assert.equal((await say(await open(), "hi")).stopReason, "end_turn");
  assert.equal(new Set(prompts().map(({ params }) => params._meta.hoplite.clientMessageId)).size, 1);
  assert.equal(prompts().length, 2);
});

test("does not retry once the run has started", async () => {
  const { open, say, prompts } = start({
    handlers: {
      "session/prompt": async ({ sessionId }, server) => {
        server.notify("_hoplite/run_phase", { sessionId, runId: "run_1", phase: "planning" });
        await soon();
        throw new RpcError({ code: -32603, message: "Internal error" });
      },
    },
  });
  await assert.rejects(say(await open(), "hi"), /Internal error/);
  assert.equal(prompts().length, 1);
});

test("a prompt sent right after a cancel waits for the first to end", async () => {
  const first = gate();
  let running = 0;
  const { open, say, client, sent } = start({
    handlers: {
      "session/prompt": async ({ prompt }) => {
        assert.equal(++running, 1);
        if (prompt[0].text === "one") await first.closed;
        running--;
        return { stopReason: prompt[0].text === "one" ? "cancelled" : "end_turn" };
      },
    },
  });
  const id = await open();
  const one = say(id, "one");
  await soon();
  client.notify("session/cancel", { sessionId: id });
  const two = say(id, "two");
  await soon();
  assert.ok(sent.some(({ method }) => method === "session/cancel"));
  first.open();
  assert.equal((await one).stopReason, "cancelled");
  assert.equal((await two).stopReason, "end_turn");
});

const question = (sessionId) => ({
  sessionId,
  mode: "form",
  message: "Tea or Coffee?",
  requestedSchema: { type: "object", properties: { q1: { type: "string", description: "Tea or Coffee?", oneOf: [{ const: "Tea" }] } } },
});

/** Hoplite asks, then ends the run and withdraws the question before it is answered. */
const asksAndLeaves = async ({ sessionId, prompt }, server) => {
  if (!/Ask me/.test(prompt[0].text)) return { stopReason: "end_turn" };
  server.send({ id: 0, method: "elicitation/create", params: question(sessionId) });
  await soon();
  server.notify("$/cancel_request", { requestId: 0 });
  return { stopReason: "end_turn" };
};

test("a question outlives its run and its answer continues the thread", async () => {
  const { open, say, onRequest, prompts } = start({ handlers: { "session/prompt": asksAndLeaves } });
  onRequest(async () => {
    await soon(120);
    return { action: "accept", content: { q1: "Coffee" } };
  });
  assert.equal((await say(await open({ elicitation: { form: {} } }), "Ask me")).stopReason, "end_turn");
  assert.equal(prompts().length, 2);
  assert.match(prompts()[1].params.prompt[0].text, /Tea or Coffee\? Coffee$/);
});

test("a question answered during its run is answered in place", async () => {
  const answered = gate();
  const { open, say, onRequest, prompts } = start({
    handlers: {
      "session/prompt": async ({ sessionId }, server) => {
        const { content } = await server.request("elicitation/create", question(sessionId));
        answered.open(content);
        return { stopReason: "end_turn" };
      },
    },
  });
  onRequest(() => ({ action: "accept", content: { q1: "Tea" } }));
  await say(await open({ elicitation: { form: {} } }), "Ask me");
  assert.deepEqual(await answered.closed, { q1: "Tea" });
  assert.equal(prompts().length, 1);
});

test("Stop and a new message both end the wait for an answer", async () => {
  const { open, say, onRequest, client, prompts } = start({ handlers: { "session/prompt": asksAndLeaves } });
  onRequest(() => new Promise(() => {}));
  const id = await open({ elicitation: { form: {} } });
  const stopped = say(id, "Ask me");
  await soon(100);
  client.notify("session/cancel", { sessionId: id });
  assert.equal((await stopped).stopReason, "cancelled");
  const replaced = say(id, "Ask me again");
  await soon(100);
  const next = say(id, "Never mind");
  assert.equal((await replaced).stopReason, "cancelled");
  assert.equal((await next).stopReason, "end_turn");
  assert.equal(prompts().length, 3);
});

test("dismissing a question ends the turn", async () => {
  const { open, say, onRequest, prompts } = start({ handlers: { "session/prompt": asksAndLeaves } });
  onRequest(async () => {
    await soon(100);
    return { action: "decline" };
  });
  assert.equal((await say(await open({ elicitation: { form: {} } }), "Ask me")).stopReason, "end_turn");
  assert.equal(prompts().length, 1);
});

test("Hoplite cannot reach this computer with other requests", async () => {
  const { open, upstreams, requests } = start();
  const id = await open();
  for (const method of ["fs/read_text_file", "terminal/create", "_hoplite/local_exec/run"]) {
    await assert.rejects(upstreams[0].server.request(method, { sessionId: id }), { code: -32601 });
  }
  await assert.rejects(upstreams[0].server.request("_hoplite/client_tools/call", { sessionId: id, server: "x", tool: "y" }));
  assert.equal(requests.length, 0);
});

test("a thread whose Hoplite process died reopens on the next prompt", async () => {
  const { open, say, upstreams, sent } = start();
  const id = await open();
  await say(id, "one");
  upstreams[0].ended = true;
  await say(id, "two");
  assert.equal(upstreams.length, 2);
  assert.ok(sent.some(({ method }) => method === "session/load"));
});

test("commands are offered and need a started thread", async () => {
  const { open, say, updates } = start();
  const id = await open();
  await soon(60);
  const offered = updates.find(({ sessionUpdate }) => sessionUpdate === "available_commands_update").availableCommands;
  assert.deepEqual(offered.map(({ name }) => name), ["compact", "pr", "pull", "push", "open", "status", "retry", "autofix"]);
  await say(id, "/open");
  assert.match(updates.at(-1).content.text, /works once this thread has had a message/);
});

test("the thread is named after the message, not the client's instructions", async () => {
  const { open, say, prompts } = start();
  await say(await open(), "<t3_code_instructions>\nhidden\n</t3_code_instructions>\n\n<user_request>\nFix the login bug\n</user_request>");
  assert.equal(prompts()[0].params._meta.hoplite.title, "Fix the login bug");
});

test("a skill starts the message even inside the client's wrapper", async () => {
  const { open, say, prompts, upstreams } = start();
  const id = await open();
  upstreams[0].server.notify("session/update", { sessionId: id, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review-pr", description: "Review" }] } });
  await soon();
  await say(id, "<t3_code_instructions>\nhidden\n</t3_code_instructions>\n\n<user_request>\n/review-pr 42\n</user_request>");
  assert.equal(prompts()[0].params.prompt[0].text, "/review-pr 42");
});

test("offers sync and readable levels, and marks a model that could not run", async () => {
  const { open, say, client, bridge } = start({ handlers: { "session/prompt": () => ({ stopReason: "refusal", _meta: { hoplite: { failure: { code: "model_not_available" } } } }) } });
  const id = await open();
  await assert.rejects(say(id, "hi"), /cannot run it in this workspace/);
  const { configOptions } = await client.request("session/set_config_option", { sessionId: id, configId: "hoplite_sync", value: "pull" });
  assert.equal(configOptions.find((option) => option.id === "hoplite_sync").currentValue, "pull");
  assert.deepEqual(configOptions.find((option) => option.id === "reasoning").options.map(({ name }) => name), ["Low", "Medium"]);
  assert.match(configOptions[0].options[0].description, /could not run/);
  assert.equal(configOptions[0].options[1].description, undefined);
  assert.equal(bridge.sessions.get(id).sync, "pull");
});

test("tells the agent once which files are the person's own", async () => {
  const { open, say, bridge, prompts } = start();
  const id = await open();
  bridge.sessions.get(id).sentFiles = ["a.txt"];
  await say(id, "one");
  await say(id, "two");
  const notes = prompts().map(({ params }) => params.prompt.some(({ text }) => /own edits to these files.*a\.txt/.test(text)));
  assert.deepEqual(notes, [true, false]);
});

test("starting agents from Hoplite is off until chosen, and can be taken back", async () => {
  const server = path.join(home, "mcp.mjs");
  fs.writeFileSync(
    server,
    `import readline from "node:readline";
const tools = [{ name: "t3_thread_list", annotations: { readOnlyHint: true } }, { name: "delegate_task" }, { name: "t3_project_delete" }];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const result = method === "tools/list" ? { tools } : method === "tools/call" ? { content: [{ type: "text", text: params.name }] } : {};
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
});`,
  );
  const { client, sent, upstreams, bridge } = start();
  await client.request("initialize", { protocolVersion: 2 });
  const { sessionId } = await client.request("session/new", { cwd: home, mcpServers: [{ name: "t3-code", command: process.execPath, args: [server], env: [] }] });
  const offered = () => sent.filter(({ method }) => method === "_hoplite/client_tools/register").at(-1).params.servers.flatMap(({ tools }) => tools.map(({ name }) => name));
  const choose = (value) => client.request("session/set_config_option", { sessionId, configId: "hoplite_tools", value });
  const call = (tool) => upstreams[0].server.request("_hoplite/client_tools/call", { sessionId, server: "t3_code", tool, arguments: {} });
  assert.deepEqual(offered(), ["t3_thread_list"]);
  await assert.rejects(call("delegate_task"), /not offered/);
  await choose("agents");
  assert.deepEqual(offered().sort(), ["delegate_task", "t3_thread_list"]);
  assert.equal((await call("delegate_task")).content[0].text, "delegate_task");
  await assert.rejects(call("t3_project_delete"), /not offered/);
  await assert.rejects(choose("write"), { code: -32602 });
  await choose("off");
  assert.deepEqual(offered(), []);
  await assert.rejects(call("t3_thread_list"));
  bridge.stop();
});

test("says where the changes are, once per setting", async () => {
  const { open, say, client, prompts } = start();
  const id = await open();
  await say(id, "one");
  await say(id, "two");
  await client.request("session/set_config_option", { sessionId: id, configId: "hoplite_sync", value: "pull" });
  await say(id, "three");
  const notes = prompts().map(({ params }) => params.prompt.map(({ text }) => /stay in this sandbox|copied into the user/.exec(text ?? "")?.[0]).find(Boolean));
  assert.deepEqual(notes, ["stay in this sandbox", undefined, "copied into the user"]);
});

test("a failed sync is a notice, not a failed turn", async () => {
  const { open, say, client, updates } = start({
    handlers: {
      "session/prompt": async ({ sessionId }, server) => {
        server.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t", title: "Edit", status: "completed" } });
        await soon();
        return { stopReason: "end_turn" };
      },
    },
  });
  const id = await open();
  await client.request("session/set_config_option", { sessionId: id, configId: "hoplite_sync", value: "both" });
  assert.equal((await say(id, "one")).stopReason, "end_turn");
  assert.equal((await say(id, "two")).stopReason, "end_turn");
  const notices = updates.filter(({ sessionUpdate }) => sessionUpdate === "notice").map(({ title }) => title);
  assert.ok(notices.includes("The changes stay in Hoplite for now"));
  assert.ok(notices.includes("Your local changes were not sent to Hoplite"));
});

test("/status and /autofix report the thread's pull request", async () => {
  const pullRequest = { number: 4, url: "https://example.test/4", state: "open", verdict: { label: "Ready to merge" }, checks: { total: 2, succeeded: 2, failing: 0, running: 0 } };
  const { open, say, updates, sent } = start({
    handlers: {
      "_hoplite/pr/status": () => ({ pullRequest }),
      "_hoplite/thread/usage": () => ({ used: 10, size: 1000, cost: { amount: 0.5 }, subscription: null }),
      "_hoplite/pr/review_loop": ({ enabled }) => ({ reviewLoop: { enabled, status: "observing" } }),
    },
  });
  const id = await open();
  await say(id, "hi");
  await say(id, "/status");
  assert.match(updates.at(-1).content.text, /#4.*Ready to merge[^]*2 passed[^]*\$0\.50/);
  await say(id, "/autofix on");
  assert.equal(sent.at(-1).params.enabled, true);
  assert.match(updates.at(-1).content.text, /Auto-fix is on/);
});

test("helpers", () => {
  assert.equal(answerText({}, { action: "cancel" }), undefined);
  assert.match(answerText(question("s"), { action: "accept", content: { q1: ["a", "b"] } }), /a, b$/);
  assert.equal(readableTitle("Read /tmp/hoplite-claude-code/src/a.ts"), "Read src/a.ts");
});

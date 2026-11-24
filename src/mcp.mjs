// Offers the ACP client's local MCP servers (stdio) to the Hoplite run as client tools.
import { spawn } from "node:child_process";
import { Rpc } from "./rpc.mjs";
import { log } from "./store.mjs";

const MAX_TOOLS = 64;
// What an agent needs to start other agents and follow them up.
const AGENT_TOOLS = new Set(["delegate_task", "task_status", "task_cancel", "t3_thread_read"]);
const offers = (mode, tool) =>
  mode === "write" || tool.annotations?.readOnlyHint === true || (mode === "agents" && AGENT_TOOLS.has(tool.name));
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export class LocalMcp {
  constructor(server, cwd) {
    this.name = server.name;
    const env = Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value]));
    this.child = spawn(server.command, server.args ?? [], { cwd, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...env } });
    this.child.stdin.on("error", () => {});
    this.child.on("error", (error) => this.rpc.close(error));
    this.child.on("exit", () => this.rpc.close(new Error(`MCP server ${server.name} stopped`)));
    this.rpc = new Rpc({
      input: this.child.stdout,
      output: this.child.stdin,
      idPrefix: "m-",
      onMessage: (message) => {
        if (message.id === undefined) return;
        if (message.method === "ping") this.rpc.send({ id: message.id, result: {} });
        else this.rpc.send({ id: message.id, error: { code: -32601, message: "Not supported" } });
      },
    });
  }
  async tools() {
    await this.rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hoplite-acp-bridge", version: "0.3.0" } }, 15_000);
    this.rpc.notify("notifications/initialized", {});
    const tools = [];
    let cursor;
    do {
      const page = await this.rpc.request("tools/list", cursor ? { cursor } : {}, 15_000);
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }
  call(name, args) {
    return this.rpc.request("tools/call", { name, arguments: args ?? {} }, 58_000);
  }
  stop() {
    this.child.kill("SIGTERM");
  }
}

/** `read` offers tools marked read-only, `agents` adds delegation, `write` offers all. Hoplite asks for approval of each call. */
export async function startLocalTools(servers, cwd, mode) {
  if (mode === "off") return undefined;
  const offered = [];
  const clients = new Map();
  for (const server of servers.slice(0, 8)) {
    if (!server.command) continue;
    const client = new LocalMcp(server, cwd);
    try {
      const usable = (await client.tools()).filter((tool) => NAME.test(tool.name) && offers(mode, tool));
      if (usable.length === 0) {
        client.stop();
        continue;
      }
      const name = server.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
      const tools = usable.sort((a, b) => AGENT_TOOLS.has(b.name) - AGENT_TOOLS.has(a.name)).slice(0, MAX_TOOLS);
      clients.set(name, { client, tools: new Set(tools.map((tool) => tool.name)) });
      offered.push({
        name,
        writes: mode !== "read",
        trusted: false,
        tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
      });
    } catch (error) {
      log(`local MCP server ${server.name} is unavailable: ${error.message}`);
      client.stop();
    }
  }
  if (offered.length === 0) return undefined;
  return {
    servers: offered,
    async call({ server, tool, arguments: args }) {
      const entry = clients.get(server);
      // Hoplite can only call what was offered.
      if (!entry?.tools.has(tool)) throw new Error(`The tool ${server}/${tool} is not offered.`);
      return entry.client.call(tool, args);
    },
    stop() {
      for (const { client } of clients.values()) client.stop();
    },
  };
}

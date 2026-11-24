// The ACP agent the client talks to. Speaks ACP v1 to both sides and keeps `hoplite acp` behind it.
import { randomUUID } from "node:crypto";
import { Rpc, RpcError } from "./rpc.mjs";
import { Upstream, ensureHoplite, isSignedIn } from "./hoplite.mjs";
import { cloudPrompt, titleFrom, userText } from "./prompt.mjs";
import { startLocalTools } from "./mcp.mjs";
import { pull, push, run } from "./sync.mjs";
import { log, neutralDir, readState, updateState } from "./store.mjs";

export const VERSION = "0.3.0";
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const CANCEL_TIMEOUT_MS = 20_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const FALLBACK_OPTION = "hoplite_fallback_project";
const SYNC_OPTION = "hoplite_sync";
const SYNC_MODES = [
  { value: "cloud", name: "Cloud only", description: "Changes stay in Hoplite until you type /pull." },
  { value: "pull", name: "Pull replies", description: "Applies the agent's changes to this folder after each reply." },
  { value: "both", name: "Two-way sync", description: "Also sends your uncommitted changes with each message after the first." },
];
const AUTH_REQUIRED = -32000;

const PREPARING = new Set([
  "provisioning_workspace",
  "resolving_repository",
  "allocating_sandbox",
  "fetching_repository",
  "configuring_workspace",
  "dispatching_run",
  "queued",
  "compacting",
]);

const TOOLS_OPTION = "hoplite_tools";
const TOOL_MODES = [
  { value: "off", name: "No local tools", description: "The agent can't see T3 Code." },
  { value: "read", name: "Read-only tools", description: "The agent can look at threads, projects and checks in T3 Code." },
  { value: "agents", name: "Can start agents", description: "It can also start T3 Code agents, which run on this computer. With full access nothing asks first." },
];

const LEVELS = { off: "Off", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", standard: "Standard", fast: "Fast" };

const COMMANDS = [
  { name: "compact", description: "Compact the Hoplite thread's context" },
  { name: "pr", description: "Open a draft pull request from this thread's work, or show the one it has" },
  { name: "pull", description: "Apply the sandbox's changes to your local checkout" },
  { name: "push", description: "Send your uncommitted local changes to the sandbox" },
  { name: "open", description: "Show this thread's Hoplite, preview and terminal links" },
  { name: "status", description: "Show this thread's pull request, context and cost" },
  { name: "retry", description: "Run the last message again" },
  { name: "autofix", description: "Turn fixing of failed checks and review comments on the pull request on or off", input: { hint: "on or off" } },
];

const authRequired = () =>
  new RpcError({ code: AUTH_REQUIRED, message: "Authentication required: sign in to Hoplite.", data: { authMethods: [{ id: "hoplite-login" }] } });
const isNoProject = (error) => /No Hoplite project/i.test(error.message);
const isAuthError = (error) => error.data?.code === "auth_required" || /not signed in|sign in to hoplite|authentication required|invalid or revoked/i.test(error.message);
const isMissing = (error) => error.code === -32004 || /(thread|session) not found/i.test(error.message);

export class Bridge {
  sessions = new Map(); // client session id -> session
  byUpstream = new Map(); // upstream session id -> session
  upstreams = new Map(); // fallback project id ("" for none) -> running `hoplite acp`
  starting = new Map();
  clientCapabilities = {};

  constructor({ input, output, cwd = process.cwd(), args = [], spawnUpstream, checkSignedIn }) {
    this.cwd = cwd;
    this.args = args;
    this.spawnUpstream = spawnUpstream ?? (async (project, handlers, directory) =>
        new Upstream({
          binary: await ensureHoplite(),
          // Hoplite runs an unlinked folder's sessions in the project of the directory it was started
          // in, which would be another repository. Started here it has none, and says so instead.
          cwd: directory ?? neutralDir(),
          args: project ? ["--project", project] : args,
          ...handlers,
        }));
    this.checkSignedIn = checkSignedIn ?? (async () => isSignedIn(await ensureHoplite()));
    this.client = new Rpc({ input, output, idPrefix: "bridge-", onMessage: (message) => void this.fromClient(message) });
    input.on("end", () => this.stop());
  }

  stop() {
    for (const session of this.sessions.values()) session.tools?.stop();
    for (const upstream of this.upstreams.values()) upstream.stop();
    this.stopped = true;
    this.onStop?.();
  }

  // ── Client → bridge ──────────────────────────────────────────────────────────

  async fromClient(message) {
    const { id, method, params = {} } = message;
    if (method === undefined) return; // an answer to a request that already ended
    if (id === undefined) {
      if (method === "session/cancel") this.cancel(params.sessionId);
      return;
    }
    try {
      this.client.send({ id, result: (await this.handle(method, params)) ?? {} });
    } catch (error) {
      const failure = error instanceof RpcError ? error : new RpcError({ code: -32603, message: error.message });
      if (!(error instanceof RpcError)) log(error.stack);
      this.client.send({ id, error: failure.toJSON() });
    }
  }

  handle(method, params) {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "authenticate":
        return this.authenticate(params);
      case "logout":
        return this.logout();
      case "session/new":
        return this.newSession(params);
      case "session/load":
      case "session/resume":
        return this.loadSession(params);
      case "session/list":
        return this.listSessions(params);
      case "session/close":
        return this.closeSession(params);
      case "session/set_config_option":
        return this.setConfigOption(params);
      case "session/set_model":
        return this.setConfigOption({ sessionId: params.sessionId, configId: "model", value: params.modelId }).then(() => ({}));
      case "session/prompt":
        return this.prompt(params);
      default:
        throw new RpcError({ code: -32601, message: `Method not found: ${method}` });
    }
  }

  initialize(params) {
    // T3 Code opens with protocolVersion 2 plus both capability fields. Hoplite would then pick its
    // experimental v2, which has no resume, live activity or questions; v1 has all of them.
    this.clientCapabilities = params.clientCapabilities ?? params.capabilities ?? {};
    this.clientInfo = params.clientInfo ?? params.info;
    return {
      protocolVersion: 1,
      agentInfo: { name: "hoplite", title: "Hoplite", version: VERSION },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { list: {}, close: {} },
        auth: { logout: {} },
      },
      authMethods: [{ id: "hoplite-login", name: "Sign in to Hoplite", description: "Opens your browser to sign in to Hoplite." }],
    };
  }

  async authenticate({ methodId }) {
    if (methodId !== "hoplite-login") throw new RpcError({ code: -32602, message: `Unknown sign-in method: ${methodId}` });
    if (await this.checkSignedIn()) return {};
    const { rpc } = await this.connect();
    await rpc.request("authenticate", { methodId: "hoplite-login" });
    return {};
  }

  async logout() {
    const binary = await ensureHoplite();
    await run(binary, ["logout"], { timeout: 60_000 });
    this.signedIn = false;
    for (const upstream of this.upstreams.values()) upstream.stop();
    return {};
  }

  /** Never lets a background check open a browser: Hoplite signs in on the first session by itself. */
  async requireSignIn() {
    if (!this.signedIn) this.signedIn = await this.checkSignedIn();
    if (!this.signedIn) throw authRequired();
  }

  async newSession({ cwd, mcpServers = [] }) {
    await this.requireSignIn();
    const session = this.register({ clientId: undefined, cwd: cwd ?? this.cwd, mcpServers });
    try {
      await this.openUpstream(session);
    } catch (error) {
      if (isAuthError(error)) {
        this.signedIn = false;
        throw authRequired();
      }
      if (!isNoProject(error)) throw error;
      // A folder with no Hoplite project still gets a session, so a client's provider check passes
      // and the models show. The reason appears if a prompt is sent before it is linked.
      session.clientId = `hbs_${randomUUID()}`;
      session.pendingReason = error.message;
      session.configOptions = readState().catalog?.configOptions ?? [];
    }
    this.sessions.set(session.clientId, session);
    this.advertiseSoon(session);
    return { sessionId: session.clientId, ...(await this.setup(session)) };
  }

  register(fields) {
    return { overrides: {}, sync: "cloud", toolMode: process.env.HOPLITE_BRIDGE_MCP ?? "read", fallbackProject: undefined, toolCalls: new Set(), textTools: new Set(), details: [], ...fields };
  }

  async openUpstream(session) {
    const upstream = await this.connect(session.fallbackProject);
    const result = await upstream.rpc.request("session/new", this.sessionParams(session), 60_000);
    session.upstreamId = result.sessionId;
    session.clientId ??= result.sessionId;
    session.fresh = true;
    session.connection = upstream;
    this.byUpstream.set(session.upstreamId, session);
    this.adopt(session, result);
    session.pendingReason = undefined;
    for (const configId of ["model", "reasoning", "speed"]) {
      const value = session.overrides[configId];
      if (value !== undefined) await this.applyOption(session, configId, value);
    }
    await this.registerTools(session);
  }

  sessionParams(session) {
    return { cwd: session.cwd, mcpServers: [] };
  }

  adopt(session, result) {
    session.configOptions = result.configOptions ?? session.configOptions ?? [];
    const meta = result._meta?.hoplite ?? {};
    session.threadUrl = meta.threadUrl ?? session.threadUrl;
    session.activeRun = meta.activeRun ?? null;
    if (meta.project?.id) {
      session.project = meta.project;
      const { id, name, repo } = meta.project;
      if (readState().projects[id]?.name !== name) {
        updateState((state) => {
          state.projects[id] = { name, repo };
        });
      }
    }
  }

  remember(session) {
    if (session.clientId === session.upstreamId && !session.fallbackProject) return;
    updateState((state) => {
      state.sessions[session.clientId] = { ...state.sessions[session.clientId], upstreamId: session.upstreamId, cwd: session.cwd, fallbackProject: session.fallbackProject };
    });
  }

  /** Remembers which sandbox state the local checkout has, so a restart doesn't pull it again. */
  rememberBaseline(session) {
    updateState((state) => {
      state.sessions[session.clientId] = {
        ...state.sessions[session.clientId],
        upstreamId: session.upstreamId,
        cwd: session.cwd,
        fallbackProject: session.fallbackProject,
        baseline: session.baseline,
        synced: session.synced,
      };
    });
  }

  async loadSession({ sessionId, cwd, mcpServers = [] }) {
    await this.requireSignIn();
    const saved = readState().sessions[sessionId] ?? {};
    const existing = this.sessions.get(sessionId);
    const session =
      existing ??
      this.register({
        clientId: sessionId,
        upstreamId: "upstreamId" in saved ? saved.upstreamId : sessionId.startsWith("hbs_") ? undefined : sessionId,
        cwd: cwd ?? saved.cwd ?? this.cwd,
        mcpServers,
        fallbackProject: saved.fallbackProject,
        baseline: saved.baseline,
        synced: saved.synced,
      });
    this.sessions.set(sessionId, session);
    session.loading = true;
    try {
      await this.reopen(session, { replay: true });
    } finally {
      session.loading = false;
    }
    this.advertiseSoon(session);
    return this.setup(session);
  }

  /** Opens the session's Hoplite thread on the current connection. */
  async reopen(session, { replay = false } = {}) {
    try {
      if (session.upstreamId === undefined) throw new RpcError({ code: -32004, message: "Session not found." });
      const upstream = await this.connect(session.fallbackProject);
      session.connection = upstream;
      this.byUpstream.set(session.upstreamId, session);
      await this.registerTools(session);
      const result = await upstream.rpc.request(
        "session/load",
        { sessionId: session.upstreamId, ...this.sessionParams(session), ...(replay ? {} : { _meta: { hoplite: { replayLimit: 1 } } }) },
        90_000,
      );
      session.fresh = false;
      this.adopt(session, result);
    } catch (error) {
      session.connection = undefined;
      if (isAuthError(error)) {
        this.signedIn = false;
        throw authRequired();
      }
      // A thread exists only after its first prompt, so a session that never got one is started anew.
      if (!isMissing(error) && !isNoProject(error)) throw error;
      const missing = isMissing(error);
      this.byUpstream.delete(session.upstreamId);
      session.upstreamId = undefined;
      try {
        if (!missing) throw error;
        await this.openUpstream(session);
      } catch (failure) {
        if (!isNoProject(failure)) throw failure;
        session.pendingReason = failure.message;
        session.configOptions = readState().catalog?.configOptions ?? [];
      }
      this.remember(session);
    }
  }

  async listSessions({ cursor, cwd }) {
    await this.requireSignIn();
    const directory = cwd ?? this.cwd;
    // Listing needs a project's own connection, which Hoplite opens only for its start directory.
    const upstream = await this.startUpstream(undefined, directory);
    let result;
    try {
      result = await upstream.rpc.request("_hoplite/session/list", { limit: 50, ...(cursor ? { cursor } : {}) }, 30_000);
    } catch (error) {
      if (/project/i.test(error.message)) return { sessions: [] };
      throw this.explain(undefined, error);
    } finally {
      upstream.stop();
    }
    return {
      // Hoplite reports the directory a thread was made in; clients match sessions to the folder they asked for.
      sessions: result.sessions.map(({ sessionId, title, updatedAt }) => ({ sessionId, title, updatedAt, cwd: directory })),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  closeSession({ sessionId }) {
    const session = this.sessions.get(sessionId);
    session?.tools?.stop();
    this.sessions.delete(sessionId);
    if (session?.upstreamId) this.byUpstream.delete(session.upstreamId);
    return {};
  }

  session(id) {
    const session = this.sessions.get(id);
    if (!session) throw new RpcError({ code: -32004, message: "Session not found." });
    return session;
  }

  // ── Models and options ───────────────────────────────────────────────────────

  /** What session/new and session/load answer: options plus each model's own reasoning levels. */
  async setup(session) {
    const catalog = await this.catalog(session);
    return {
      configOptions: this.clientOptions(session),
      ...(catalog ? { models: this.modelState(session, catalog) } : {}),
      ...(session.threadUrl ? { _meta: { hoplite: { threadUrl: session.threadUrl } } } : {}),
    };
  }

  clientOptions(session) {
    const options = session.configOptions.map((option) => ({
      ...option,
      ...(session.overrides[option.id] !== undefined && session.upstreamId === undefined ? { currentValue: session.overrides[option.id] } : {}),
      options: option.options.map((choice) => this.readableChoice(option.id, choice)),
    }));
    options.push({
      type: "select",
      id: SYNC_OPTION,
      name: "Changes",
      description: "Hoplite's agents work in the cloud. Choose what reaches this folder.",
      currentValue: session.sync,
      options: SYNC_MODES,
    });
    options.push({
      type: "select",
      id: TOOLS_OPTION,
      name: "T3 Code tools",
      description: "What Hoplite's cloud agent may use on this computer.",
      currentValue: session.toolMode,
      options: session.toolMode === "write" ? [...TOOL_MODES, { value: "write", name: "All tools" }] : TOOL_MODES,
    });
    const projects = Object.entries(readState().projects);
    if ((session.project && !session.fallbackProject) || projects.length === 0) return options;
    // Only for a folder Hoplite doesn't know, so a saved choice can never redirect a linked repository.
    return [
      ...options,
      {
        type: "select",
        id: FALLBACK_OPTION,
        name: "Hoplite project",
        description: "Used only for folders that are not linked to a Hoplite project.",
        currentValue: session.fallbackProject ?? "none",
        options: [{ value: "none", name: "Linked to folder" }, ...projects.map(([id, project]) => ({ value: id, name: project.name ?? id }))],
      },
    ];
  }

  /** Hoplite names levels by their id, and lists models the workspace cannot run. */
  readableChoice(optionId, choice) {
    if (optionId === "model") {
      const failed = readState().unavailable[choice.value];
      return failed ? { ...choice, description: "Hoplite could not run this in your workspace when you last tried." } : choice;
    }
    return { ...choice, name: LEVELS[choice.name] ?? choice.name };
  }

  modelState(session, catalog) {
    const option = session.configOptions.find((candidate) => candidate.id === "model");
    if (!option) return undefined;
    return {
      currentModelId: session.overrides.model ?? option.currentValue,
      availableModels: option.options.map(({ value, name }) => {
        const reasoning = catalog.reasoning[value];
        return {
          modelId: value,
          name,
          _meta: reasoning
            ? {
                supportsReasoningEffort: reasoning.options.length > 1,
                reasoningEffort: reasoning.currentValue,
                reasoningEfforts: reasoning.options.map((level) => ({ value: level.value, label: LEVELS[level.name] ?? level.name })),
              }
            : null,
        };
      }),
    };
  }

  /** Hoplite reports reasoning only for the selected model, so each is asked once on an unused session. */
  async catalog(session) {
    const saved = readState().catalog;
    const ids = (session.configOptions.find((option) => option.id === "model")?.options ?? []).map((option) => option.value);
    if (session.upstreamId === undefined) return saved;
    const fresh = saved && Date.now() - saved.savedAt < CATALOG_TTL_MS && ids.every((id) => id in saved.reasoning);
    if (fresh) return saved;
    const refresh = (this.catalogRefresh ??= this.fetchCatalog(session, ids).finally(() => (this.catalogRefresh = undefined)));
    if (saved) {
      refresh.catch((error) => log(`could not refresh models: ${error.message}`));
      return saved;
    }
    return Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, 8_000).unref())]).catch((error) => {
      log(`could not read models: ${error.message}`);
      return undefined;
    });
  }

  async fetchCatalog(session, ids) {
    const { rpc } = session.connection;
    const scratch = await rpc.request("session/new", this.sessionParams(session), 30_000);
    const reasoning = {};
    await Promise.all(
      ids.map(async (id) => {
        try {
          const result = await rpc.request("session/set_config_option", { sessionId: scratch.sessionId, configId: "model", value: id }, 20_000);
          const option = result.configOptions.find((candidate) => candidate.id === "reasoning");
          if (option) reasoning[id] = { currentValue: option.currentValue, options: option.options.map(({ value, name }) => ({ value, name })) };
        } catch {
          // A model the plan no longer offers simply has no levels.
        }
      }),
    );
    const catalog = { savedAt: Date.now(), configOptions: scratch.configOptions, reasoning };
    updateState((state) => {
      state.catalog = catalog;
    });
    return catalog;
  }

  async setConfigOption({ sessionId, configId, value }) {
    const session = this.session(sessionId);
    if (configId === SYNC_OPTION) {
      if (!SYNC_MODES.some((mode) => mode.value === value)) throw new RpcError({ code: -32602, message: "Unknown sync mode." });
      session.sync = value;
    } else if (configId === TOOLS_OPTION) {
      if (!TOOL_MODES.some((mode) => mode.value === value) && value !== session.toolMode) throw new RpcError({ code: -32602, message: "Unknown tool mode." });
      if (value !== session.toolMode) {
        session.toolMode = value;
        session.tools?.stop();
        session.tools = undefined;
        if (session.upstreamId !== undefined && session.connection && !session.connection.ended) await this.registerTools(session, { replace: true });
      }
    } else if (configId === FALLBACK_OPTION) {
      const known = value === "none" || value in readState().projects;
      if (!known) throw new RpcError({ code: -32602, message: "Unknown Hoplite project." });
      const project = value === "none" ? undefined : value;
      // Clients remember the choice per provider and send it for every folder. A linked one ignores it.
      const linked = session.project && !session.fallbackProject;
      if (linked || project === session.fallbackProject) return { configOptions: this.clientOptions(session) };
      if (session.upstreamId !== undefined) {
        if (!session.fresh) throw new RpcError({ code: -32602, message: "A started thread stays in its project. Start a new thread to use another." });
        this.byUpstream.delete(session.upstreamId);
        session.upstreamId = undefined;
        session.connection = undefined;
        session.project = undefined;
      }
      session.fallbackProject = project;
      // Runs start in the chosen project from the next prompt; a linked folder never shows this option.
      this.remember(session);
    } else if (session.upstreamId === undefined) {
      const option = session.configOptions.find((candidate) => candidate.id === configId);
      if (!option) throw new RpcError({ code: -32602, message: `Unknown option: ${configId}` });
      const levels = configId === "reasoning" && readState().catalog?.reasoning[session.overrides.model]?.options;
      if (!(levels || option.options).some((choice) => choice.value === value)) throw new RpcError({ code: -32602, message: `${value} is not available.` });
      session.overrides[configId] = value;
    } else {
      await this.ensureOpen(session);
      await this.applyOption(session, configId, value);
    }
    return { configOptions: this.clientOptions(session) };
  }

  async applyOption(session, configId, value) {
    const { rpc } = session.connection;
    try {
      const result = await rpc.request("session/set_config_option", { sessionId: session.upstreamId, configId, value }, 30_000);
      session.configOptions = result.configOptions;
      session.overrides[configId] = value;
      if (configId === "model") session.compactsNext = result._meta?.hoplite?.compactsContext === true && !session.fresh;
    } catch (error) {
      // Clients remember levels per provider, so a model can be sent one it lacks. It keeps its default.
      if (configId === "model" || error.code !== -32602) throw error;
      log(`${configId}=${value} is not available for this model`);
    }
  }

  // ── Prompts ──────────────────────────────────────────────────────────────────

  async prompt(params) {
    const session = this.session(params.sessionId);
    // A client may cancel and prompt again at once; Hoplite refuses a second prompt until the first ends.
    if (session.active) {
      // A new message instead of an answer to an open question ends the wait for it.
      if (session.active.runStarted) session.active.interrupt();
      await Promise.race([session.active.done, new Promise((resolve) => setTimeout(resolve, CANCEL_TIMEOUT_MS).unref())]);
    }
    if (session.active) throw new RpcError({ code: -32603, message: "Hoplite is still stopping the previous message. Try again in a moment." });
    let finish;
    const active = { cancelled: false, done: new Promise((resolve) => (finish = resolve)), questions: [], phase: undefined, lastKind: undefined };
    active.interrupted = new Promise((resolve) => (active.interrupt = resolve));
    session.active = active;
    try {
      return await this.runPrompt(session, active, params);
    } finally {
      this.endPhase(session, active);
      await this.flushDetails(session);
      session.active = undefined;
      finish();
    }
  }

  async runPrompt(session, active, params) {
    await this.ensureOpen(session);
    const text = params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
    const command = /^\/(compact|pr|pull|push|open|status|retry|autofix)(?:\s+([\s\S]*))?$/.exec(userText(text));
    if (command) return this.command(session, active, command[1], (command[2] ?? "").trim());
    const { blocks, problems } = cloudPrompt(params.prompt, session.cwd);
    if (problems.length > 0) this.notice(session, "Some files were not sent to Hoplite", problems.join("; "), "warning");
    const skill = /^\/([\w.:-]+)/.exec(userText(text))?.[1];
    if (skill && session.skills?.some(({ name }) => name === skill)) {
      // Hoplite runs a skill only when the message starts with it; the client's wrapper comes first.
      blocks.unshift({ type: "text", text: userText(text) });
    }
    const hoplite = { clientMessageId: randomUUID() };
    if (session.fresh) {
      // Otherwise Hoplite names the thread after the client's hidden instructions.
      const title = titleFrom(params.prompt);
      if (title) hoplite.title = title;
      blocks.push({
        type: "text",
        text: "<environment_note>\nYou are in a Hoplite cloud sandbox with its own clone of the repository. The user reads your replies in a desktop client on another computer: local paths, browsers, devices and tools of that computer mentioned in instructions are not available to you unless they are in your tool list. Commit, push or open a pull request only when asked. Name repository files by their path from the repository root, as plain text or code, never as links to sandbox paths.\n</environment_note>",
      });
    }
    if (session.sync === "both" && !session.fresh) await this.syncUp(session);
    if (active.cancelled) return { stopReason: "cancelled" };
    if (session.toldSync !== session.sync) {
      // Another agent may have delegated this and be about to read the files.
      blocks.push({ type: "text", text: `<environment_note>\n${session.sync === "cloud" ? "File changes you make stay in this sandbox until the user applies them with /pull. When you changed files, end with one short sentence saying so." : "After each reply your file changes are copied into the user's own checkout, uncommitted."}\n</environment_note>` });
    }
    if (session.sentFiles) {
      const shown = session.sentFiles.slice(0, 20);
      const more = session.sentFiles.length - shown.length;
      blocks.push({ type: "text", text: `<environment_note>\nThe user's own edits to these files were just copied into this sandbox: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.\n</environment_note>` });
    }
    const send = (delivery) =>
      session.connection.rpc.request("session/prompt", {
        sessionId: session.upstreamId,
        prompt: blocks,
        _meta: { hoplite: { ...hoplite, ...(delivery ? { delivery } : {}) } },
      });
    active.sent = true;
    try {
      let result;
      try {
        result = await this.retrying(active, () => send(session.activeRun ? "steer" : undefined));
      } catch (error) {
        if (!["prompt_in_flight", "thread_has_active_run"].includes(error.data?.code)) throw error;
        result = await send("queue");
      }
      session.fresh = false;
      session.sentFiles = undefined;
      session.toldSync = session.sync;
      const finished = this.finishRun(session, active, await this.answerLate(session, active, result));
      this.modelWorks(session);
      if (session.sync !== "cloud" && active.usedTools && finished.stopReason === "end_turn") await this.syncDown(session);
      return finished;
    } catch (error) {
      if (active.cancelled) return { stopReason: "cancelled" };
      throw this.explain(session, error);
    }
  }

  /**
   * Hoplite fails a thread started within about a second of another in the same project with a bare
   * "Internal error". The message id stays the same, so a retry cannot send the message twice.
   */
  async retrying(active, send) {
    for (const delay of RETRY_DELAYS_MS) {
      try {
        return await send();
      } catch (error) {
        if (error.code !== -32603 || error.message !== "Internal error" || active.started || active.cancelled) throw error;
        log("Hoplite answered with an internal error; trying again");
        await new Promise((resolve) => setTimeout(resolve, delay * (1 + Math.random() / 2)));
        if (active.cancelled) throw error;
      }
    }
    return send();
  }

  /** Before the turn ends, so the client's own diff of the turn includes the changes. */
  async syncDown(session) {
    try {
      const { files } = await pull(session);
      this.rememberBaseline(session);
      if (files > 0) this.notice(session, `Applied ${files} changed file${files === 1 ? "" : "s"} to this folder`);
    } catch (error) {
      this.notice(session, "The changes stay in Hoplite for now", error.message, "warning");
    }
  }

  async syncUp(session) {
    try {
      const { files } = await push(session);
      if (files === 0) return;
      this.rememberBaseline(session);
      this.notice(session, `Sent ${files} changed file${files === 1 ? "" : "s"} to the sandbox`);
    } catch (error) {
      this.notice(session, "Your local changes were not sent to Hoplite", error.message, "warning");
    }
  }

  modelWorks(session) {
    const model = session.configOptions.find((option) => option.id === "model")?.currentValue;
    if (model && readState().unavailable[model]) updateState((state) => delete state.unavailable[model]);
  }

  /**
   * A run may end with its question still open. The turn then waits for the person and sends the
   * answer as the next message, which is what Hoplite does with an answer given in its own app.
   */
  async answerLate(session, active, result) {
    for (;;) {
      const open = active.questions.splice(0).filter((question) => question.withdrawn);
      if (open.length === 0 || result.stopReason !== "end_turn" || active.cancelled) return result;
      const elsewhere = new Promise((resolve) => (active.runStarted = () => resolve("elsewhere")));
      const ended = new Promise((resolve) => (active.runEnded = resolve));
      const outcome = await Promise.race([Promise.all(open.map(({ answer }) => answer)), elsewhere, active.interrupted]);
      active.runStarted = undefined;
      if (active.cancelled || outcome === undefined) return { stopReason: "cancelled" };
      if (outcome === "elsewhere") {
        // Answered in Hoplite's own app, which starts the next run; this turn follows it to its end.
        const status = await Promise.race([ended, active.interrupted]);
        return { stopReason: status === "completed" ? "end_turn" : active.cancelled || status === "cancelled" ? "cancelled" : "refusal" };
      }
      active.runEnded = undefined;
      const lines = open.map(({ params }, index) => answerText(params, outcome[index])).filter(Boolean);
      if (lines.length === 0) return result;
      active.separate = true;
      const message = { sessionId: session.upstreamId, prompt: [{ type: "text", text: lines.join("\n") }] };
      const clientMessageId = randomUUID();
      active.started = false;
      await this.ensureOpen(session);
      result = await this.retrying(active, () =>
        session.connection.rpc.request("session/prompt", { ...message, _meta: { hoplite: { clientMessageId } } }),
      );
    }
  }

  finishRun(session, active, result) {
    if (active.cancelled || result.stopReason === "cancelled") return { stopReason: "cancelled" };
    const failure = result._meta?.hoplite?.failure ?? active.failure;
    if (result.stopReason === "refusal" || failure) throw this.failed(session, failure);
    const usage = result._meta?.hoplite?.usage;
    return { stopReason: result.stopReason, ...(usage ? { _meta: { hoplite: { usage } } } : {}) };
  }

  /** Hoplite's failed runs end as `refusal`, which clients show without the reason; an error keeps it. */
  failed(session, failure = {}) {
    if (failure.code === "model_not_available" || failure.code === "invalid_model") return this.modelUnavailable(session);
    const title = failure.title ?? "The Hoplite run failed";
    const lines = [failure.message && failure.message !== title ? `${title}: ${failure.message}` : title];
    if (failure.error && !lines[0].includes(failure.error)) lines.push(failure.error);
    if (failure.resetsAt) lines.push(`Resets at ${failure.resetsAt}.`);
    for (const action of failure.actions ?? []) if (action.url) lines.push(`${action.label}: ${action.url}`);
    return new RpcError({ code: -32603, message: lines.join("\n"), data: { code: failure.code } });
  }

  modelUnavailable(session) {
    const option = session.configOptions.find((candidate) => candidate.id === "model");
    const name = option?.options.find((choice) => choice.value === option.currentValue)?.name ?? option?.currentValue ?? "This model";
    if (option && !readState().unavailable[option.currentValue]) {
      updateState((state) => {
        state.unavailable[option.currentValue] = Date.now();
      });
    }
    return new RpcError({
      code: -32603,
      message: `Hoplite lists ${name} but cannot run it in this workspace. Choose another model, or connect its subscription or add credits at https://app.hoplite.sh/settings.`,
      data: { code: "model_not_available" },
    });
  }

  explain(session, error) {
    if (!(error instanceof RpcError)) return error;
    if (isAuthError(error)) {
      this.signedIn = false;
      return authRequired();
    }
    if (["invalid_model", "model_not_available"].includes(error.data?.code)) return this.modelUnavailable(session);
    const url = error.data?.billingUrl;
    // Hoplite reuses -32000 for refusals such as missing credits; clients read that code as signed out.
    return new RpcError({ code: error.code === AUTH_REQUIRED ? -32603 : error.code, message: url ? `${error.message} ${url}` : error.message, data: error.data });
  }

  /** Makes sure the session has a Hoplite thread on a live connection. */
  async ensureOpen(session) {
    if (session.upstreamId !== undefined && session.connection && !session.connection.ended) return;
    if (session.upstreamId !== undefined) return this.reopen(session);
    try {
      await this.openUpstream(session);
    } catch (error) {
      if (!isNoProject(error)) throw this.explain(session, error);
      throw new RpcError({
        code: -32603,
        message: `${session.cwd} is not linked to a Hoplite project. ${
          Object.keys(readState().projects).length > 0 ? 'Choose "Hoplite project" in the model options, or link' : "Link"
        } its GitHub repository at https://app.hoplite.sh, then send this again.`,
        data: { code: "no_project" },
      });
    }
    this.remember(session);
  }

  cancel(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.active) {
      session.active.cancelled = true;
      session.active.interrupt();
    }
    if (session.upstreamId && session.connection && (!session.active || session.active.sent)) {
      session.connection.rpc.notify("session/cancel", { sessionId: session.upstreamId });
    }
  }

  async command(session, active, name, argument) {
    const say = (text) => this.update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    const { rpc } = session.connection;
    const params = { sessionId: session.upstreamId };
    try {
      if (session.fresh) {
        say(`\`/${name}\` works once this thread has had a message.`);
        return { stopReason: "end_turn" };
      }
      if (name === "compact") {
        const compactionId = randomUUID();
        this.update(session, { sessionUpdate: "compaction_update", compactionId, status: "in_progress" });
        try {
          active.compacting = true;
          const ended = new Promise((resolve) => (active.runEnded = resolve));
          const { result } = await rpc.request("_hoplite/thread/compact", params, 60_000);
          const outcome = ["completed", "failed", "cancelled"].includes(result?.status) ? result.status : await ended;
          this.update(session, { sessionUpdate: "compaction_update", compactionId, status: outcome === "completed" ? "completed" : "failed" });
          if (outcome !== "completed") throw this.failed(session, active.failure ?? { title: "Compaction did not finish" });
        } catch (error) {
          this.update(session, { sessionUpdate: "compaction_update", compactionId, status: "failed", error: error.message });
          throw error;
        }
      } else if (name === "pr") {
        const { created, pullRequest } = await rpc.request("_hoplite/pr/create", { ...params, ...(argument ? { title: argument } : {}) }, 120_000);
        say(`${created ? "Opened draft pull request" : "This thread already has pull request"} [#${pullRequest.number}](${pullRequest.url}).`);
      } else if (name === "open") {
        const links = await rpc.request("_hoplite/thread/links", { ...params, preview: false }, 30_000);
        say(
          [
            ["Thread", links.threadUrl],
            ["Preview", links.previewUrl],
            ["Terminal", links.terminalUrl],
            ["Pull request", links.pullRequestUrl],
          ]
            .filter(([, url]) => url)
            .map(([label, url]) => `- [${label}](${url})`)
            .join("\n"),
        );
      } else if (name === "push") {
        const { files } = await push(session);
        this.rememberBaseline(session);
        say(files === 0 ? "The sandbox already has your changes." : `Sent ${files} changed file${files === 1 ? "" : "s"} to the sandbox.`);
      } else if (name === "pull") {
        const { root, files } = await pull(session);
        this.rememberBaseline(session);
        say(files === 0 ? "The sandbox has no new changes." : `Applied ${files} changed file${files === 1 ? "" : "s"} to ${root}. Nothing was committed.`);
      } else if (name === "status") {
        const [{ pullRequest }, usage] = await Promise.all([rpc.request("_hoplite/pr/status", params, 30_000), rpc.request("_hoplite/thread/usage", params, 30_000)]);
        say(statusText(session, pullRequest, usage));
      } else if (name === "autofix") {
        const enabled = { on: true, off: false }[argument.toLowerCase()];
        const { reviewLoop } = await rpc.request("_hoplite/pr/review_loop", { ...params, ...(enabled === undefined ? {} : { enabled }) }, 60_000);
        say(reviewLoop ? `Auto-fix is ${reviewLoop.enabled ? "on" : "off"} (${reviewLoop.status}).` : "This thread has no pull request yet. Open one with `/pr`.");
      } else if (name === "retry") {
        active.sent = true;
        return this.finishRun(session, active, await rpc.request("_hoplite/run/retry", params));
      }
      return { stopReason: "end_turn" };
    } catch (error) {
      if (active.cancelled) return { stopReason: "cancelled" };
      throw this.explain(session, error);
    }
  }

  // ── Hoplite → bridge ─────────────────────────────────────────────────────────

  connect(project = "") {
    const current = this.upstreams.get(project);
    if (current && !current.ended) return Promise.resolve(current);
    const starting = this.starting.get(project);
    if (starting) return starting;
    const start = this.startUpstream(project).finally(() => this.starting.delete(project));
    this.starting.set(project, start);
    return start;
  }

  async startUpstream(project, directory) {
    let upstream;
    upstream = await this.spawnUpstream(project, {
      onMessage: (message) => this.fromUpstream(upstream, message),
      onStderr: (line) => void this.offerSignInUrl(line),
      onExit: () => {
        for (const session of this.sessions.values()) if (session.connection === upstream) session.active?.runEnded?.("failed");
      },
    }, directory);
    if (directory === undefined) this.upstreams.set(project, upstream);
    try {
      await upstream.rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: this.clientInfo ?? { name: "hoplite-acp-bridge", version: VERSION },
          // Files and terminals live in the sandbox; only questions come back to the client.
          clientCapabilities: this.clientCapabilities.elicitation?.form ? { elicitation: { form: {} } } : {},
        },
        60_000,
      );
    } catch (error) {
      upstream.stop();
      throw error;
    }
    return upstream;
  }

  /** Lets a client on another device open the sign-in page the CLI prints. */
  async offerSignInUrl(line) {
    const url = /https:\/\/\S+/.exec(line)?.[0];
    if (!url || !/sign|log|device|auth/i.test(line) || !this.clientCapabilities.elicitation?.url || this.offeredUrl === url) return;
    this.offeredUrl = url;
    await this.client
      .request("elicitation/create", { mode: "url", elicitationId: randomUUID(), url, message: "Sign in to Hoplite" })
      .catch(() => {});
  }

  fromUpstream(upstream, message) {
    const { id, method, params = {} } = message;
    if (method === undefined) return;
    const session = this.byUpstream.get(params.sessionId);
    if (method === "$/cancel_request") return this.withdraw(upstream, params.requestId);
    if (id !== undefined) return void this.upstreamRequest(upstream, message, session);
    if (!session) return;
    if (method === "session/update") return this.forwardUpdate(session, params.update);
    if (session.active && /^_hoplite\/run_/.test(method)) session.active.started = true;
    if (method === "_hoplite/run_phase") return this.phase(session, params);
    if (method === "_hoplite/run_failed" && session.active) session.active.failure = params.failure;
    if (method === "_hoplite/run_status") {
      const running = params.status === "running";
      session.activeRun = running ? { runId: params.runId } : null;
      if (running) session.active?.runStarted?.();
      else session.active?.runEnded?.(params.status);
    }
    if (method === "_hoplite/pr_status") this.pullRequest(session, params);
  }

  async upstreamRequest({ rpc }, { id, method, params }, session) {
    try {
      if (method === "_hoplite/client_tools/call") {
        if (!session?.tools) throw new Error("Local tools are not available.");
        return rpc.send({ id, result: await session.tools.call(params) });
      }
      // Local command execution is never offered, so nothing else may reach this computer.
      if (!session || !["session/request_permission", "elicitation/create"].includes(method)) {
        throw new RpcError({ code: -32601, message: `Method not found: ${method}` });
      }
      const answer = this.client.request(method, { ...params, sessionId: session.clientId });
      const question = method === "elicitation/create" && session.active ? { upstreamRequest: id, params, answer } : undefined;
      if (question) session.active.questions.push(question);
      const result = await answer;
      if (question) question.settled = true;
      if (!question?.withdrawn) rpc.send({ id, result });
    } catch (error) {
      rpc.send({ id, error: { code: error.code ?? -32603, message: error.message } });
    }
  }

  /** Hoplite takes a question back when its run ends; `answerLate` then carries the answer. */
  withdraw(upstream, requestId) {
    for (const { connection, active } of this.sessions.values()) {
      if (connection !== upstream) continue;
      const question = active?.questions.find((candidate) => candidate.upstreamRequest === requestId);
      if (question && !question.settled) question.withdrawn = true;
    }
  }

  update(session, update) {
    this.client.notify("session/update", { sessionId: session.clientId, update });
  }

  notice(session, title, description, severity = "info") {
    this.update(session, { sessionUpdate: "notice", severity, title, ...(description ? { description } : {}) });
  }

  forwardUpdate(session, update) {
    const { active } = session;
    switch (update.sessionUpdate) {
      case "available_commands_update":
        session.skills = update.availableCommands;
        this.advertise(session);
        return;
      case "config_option_update":
        session.configOptions = update.configOptions;
        this.update(session, { ...update, configOptions: this.clientOptions(session) });
        return;
      case "usage_update":
      case "session_info_update":
        this.update(session, update);
        return;
    }
    // Replayed history goes through as it is; the client decides what to keep.
    if (session.loading) {
      this.update(session, update);
      return;
    }
    // Activity with no prompt of ours (a teammate, the web app) has no turn to belong to.
    if (!active) return;
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        return;
      case "agent_message_chunk": {
        // The failure is thrown as the prompt's error instead.
        if (update._meta?.hoplite?.failureNotice) return;
        let { content } = update;
        // Hoplite echoes the raw form answer back as a message; the question card already shows it.
        if (/^\s*On it — I've received your instruction: “Answers to the agent question [^]*”\.\s*$/.test(content.text ?? "")) return;
        // v1 separates texts with a blank line; after a tool call the client has already split them.
        if (active.lastKind !== "text" && content.type === "text") {
          content = { ...content, text: content.text.replace(/^\n+/, "") };
          if (!content.text) return;
        }
        if (active.separate && content.type === "text") content = { ...content, text: `\n\n${content.text.replace(/^\n+/, "")}` };
        active.separate = false;
        this.endPhase(session, active);
        active.lastKind = "text";
        this.update(session, { ...update, content });
        return;
      }
      case "agent_thought_chunk":
        this.endPhase(session, active);
        active.lastKind = "thought";
        this.update(session, update);
        return;
      case "tool_call":
      case "tool_call_update":
        this.endPhase(session, active);
        active.lastKind = "tool";
        active.usedTools = true;
        active.separate = false;
        this.forwardTool(session, update);
        return;
      default:
        this.update(session, update);
    }
  }

  forwardTool(session, update) {
    // After a reconnect Hoplite may announce a call the client already shows, or only update one it never saw.
    const known = session.toolCalls.has(update.toolCallId);
    session.toolCalls.add(update.toolCallId);
    const next = {
      ...update,
      sessionUpdate: known ? "tool_call_update" : "tool_call",
      ...(update.title ? { title: readableTitle(update.title) } : {}),
      ...(known || update.title ? {} : { title: "Tool" }),
    };
    this.update(session, next);
    if (update._meta?.hoplite?.outputTruncated && ["completed", "failed"].includes(update.status)) {
      session.details.push(this.fullOutput(session, update.toolCallId));
    }
  }

  /** Hoplite previews 2,048 characters of a result; the rest is fetched so the client has all of it. */
  async fullOutput(session, toolCallId) {
    try {
      const detail = await session.connection.rpc.request("_hoplite/tool/detail", { sessionId: session.upstreamId, toolCallId }, 10_000);
      const text = detail.text ?? detail.outputText;
      if (!text) return;
      this.update(session, { sessionUpdate: "tool_call_update", toolCallId, rawOutput: text, content: [{ type: "content", content: { type: "text", text } }] });
    } catch (error) {
      log(`could not read the full output of ${toolCallId}: ${error.message}`);
    }
  }

  async flushDetails(session) {
    const details = session.details.splice(0);
    if (details.length > 0) await Promise.allSettled(details);
  }

  phase(session, { runId, phase, label }) {
    const { active } = session;
    if (!active || active.compacting) return;
    if (phase === "compacting" && session.compactsNext) {
      this.endPhase(session, active);
      active.phase = { compactionId: `hoplite-compaction-${runId}` };
      return this.update(session, { sessionUpdate: "compaction_update", compactionId: active.phase.compactionId, status: "in_progress" });
    }
    if (active.phase?.compactionId && phase !== "compacting") this.endPhase(session, active);
    // Hoplite also reports "compacting" while it only prepares a follow-up's context.
    if (!PREPARING.has(phase)) return this.endPhase(session, active);
    const current = active.phase ?? { id: `hoplite-prepare-${runId}` };
    if (current.phase === phase) return;
    current.phase = phase;
    current.label = phase === "compacting" ? "Preparing context" : label;
    current.finished = phase === "compacting" ? "Context ready" : "Workspace ready";
    active.phase = current;
    if (current.shown) this.forwardToolState(session, current.id, current.label, "in_progress");
    else {
      // Follow-up runs pass through here in under a second; only a real wait is worth showing.
      current.timer ??= setTimeout(() => {
        current.shown = true;
        this.forwardToolState(session, current.id, current.label, "in_progress");
      }, 1_500);
    }
  }

  forwardToolState(session, toolCallId, title, status) {
    const known = session.toolCalls.has(toolCallId);
    session.toolCalls.add(toolCallId);
    this.update(session, { sessionUpdate: known ? "tool_call_update" : "tool_call", toolCallId, title, kind: "other", status });
  }

  endPhase(session, active) {
    const { phase } = active;
    if (!phase) return;
    active.phase = undefined;
    clearTimeout(phase.timer);
    if (phase.compactionId) {
      session.compactsNext = false;
      this.update(session, { sessionUpdate: "compaction_update", compactionId: phase.compactionId, status: "completed" });
    } else if (phase.shown) this.forwardToolState(session, phase.id, phase.finished, "completed");
  }

  pullRequest(session, { pullRequest, significance }) {
    if (!pullRequest || !session.active) return;
    const name = `Pull request #${pullRequest.number}`;
    const title = {
      created: `${name} opened`,
      merged: `${name} merged`,
      closed: `${name} closed`,
      checks_failed: `${name}: checks failed`,
      checks_completed: `${name}: checks passed`,
    }[significance];
    if (title) this.notice(session, title, pullRequest.url, significance === "checks_failed" ? "warning" : "info");
  }

  advertiseSoon(session) {
    // After the response, so the client knows the session the update names.
    setTimeout(() => this.advertise(session), 20).unref();
  }

  advertise(session) {
    if (!this.sessions.has(session.clientId)) return;
    const taken = new Set(COMMANDS.map((command) => command.name));
    this.update(session, {
      sessionUpdate: "available_commands_update",
      availableCommands: [...COMMANDS, ...(session.skills ?? []).filter((skill) => !taken.has(skill.name))],
    });
  }

  // ── Local tools ──────────────────────────────────────────────────────────────

  async registerTools(session, { replace = false } = {}) {
    if (session.mcpServers.length === 0) return;
    try {
      if (session.toolMode !== "off") session.tools ??= await startLocalTools(session.mcpServers, session.cwd, session.toolMode);
      const servers = session.tools?.servers ?? [];
      if (servers.length === 0 && !replace) return;
      const result = await session.connection.rpc.request("_hoplite/client_tools/register", { sessionId: session.upstreamId, servers }, 20_000);
      if (result.dropped?.length) log(`Hoplite refused local tools: ${result.dropped.join(", ")}`);
    } catch (error) {
      log(`local tools are unavailable: ${error.message}`);
    }
  }
}

function statusText(session, pullRequest, usage) {
  const lines = [];
  if (pullRequest) {
    const { checks } = pullRequest;
    lines.push(`Pull request [#${pullRequest.number}](${pullRequest.url}): ${pullRequest.verdict?.label ?? pullRequest.state}`);
    if (checks?.total) lines.push(`Checks: ${checks.succeeded} passed, ${checks.failing} failed, ${checks.running} running`);
    if (pullRequest.unresolvedComments) lines.push(`Unresolved review comments: ${pullRequest.unresolvedComments}`);
    if (pullRequest.reviewLoop) lines.push(`Auto-fix: ${pullRequest.reviewLoop.enabled ? "on" : "off"}`);
  } else lines.push("Pull request: none");
  if (usage?.size) lines.push(`Context: ${usage.used.toLocaleString("en")} of ${usage.size.toLocaleString("en")} tokens`);
  if (usage?.cost) lines.push(`Cost: $${usage.cost.amount.toFixed(2)}`);
  if (usage?.subscription) lines.push(`Paid by: ${usage.subscription.replaceAll("_", " ")} subscription`);
  if (session.threadUrl) lines.push(`[Open in Hoplite](${session.threadUrl})`);
  return lines.map((line) => `- ${line}`).join("\n");
}

/** The person's form answer as a message to the agent; nothing when they dismissed the form. */
export function answerText(params, result) {
  if (result?.action !== "accept") return undefined;
  const fields = params.requestedSchema?.properties ?? {};
  const answers = Object.entries(result.content ?? {}).map(([key, value]) => {
    const field = fields[key] ?? {};
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    return `${field.description ?? field.title ?? key} ${text}`;
  });
  return answers.length > 0 ? `My answer to your question:\n${answers.join("\n")}` : undefined;
}

/** Drops the sandbox's checkout path, which says nothing to the user. */
export function readableTitle(title) {
  return title.replaceAll("/tmp/hoplite-claude-code/", "").replace(/ \/tmp\/hoplite-claude-code$/, " the repository");
}

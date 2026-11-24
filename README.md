# hoplite-acp-bridge

Use [Hoplite](https://hoplite.sh)'s cloud agents in [T3 Code](https://github.com/pingdotgg/t3code). It sits between T3 Code and `hoplite acp` and fixes what breaks between them. It changes no T3 Code code.

Unofficial: not made or endorsed by Hoplite or T3 Code.

## Install

You need Node 20 or newer, on macOS or Linux.

```sh
npm install -g github:SoulSniper-V2/hoplite-acp-bridge
hoplite-acp-bridge setup
```

`setup` installs the Hoplite CLI if you don't have it, opens your browser to sign in, finds your linked repositories and loads the models.

Then in T3 Code: **Settings → Providers → Add provider → Show more → Local ACP command**. Set the executable to the path `setup` printed, and name it Hoplite.

Your repository must be linked to a Hoplite project at https://app.hoplite.sh. For a folder that isn't, pick one under **Hoplite project** in the model options.

## Where the work happens

The agent edits a clone in Hoplite's cloud, which starts from GitHub. **Changes** in T3 Code's model options decides what reaches your folder:

| Changes | What happens |
| --- | --- |
| Cloud only (default) | Nothing, until you type `/pull` |
| Pull replies | The agent's changes are applied to your folder after each reply, so T3 Code's diff shows them |
| Two-way sync | Your own changes are also sent, with each message after the first |

Applying is all or nothing and commits nothing. If your folder conflicts, nothing is changed and you're told. Credential files such as `.env` are never sent, and only a checkout of the thread's own repository is ever changed.

## Commands

| Command | What it does |
| --- | --- |
| `/pull` | Applies the sandbox's new changes to your folder |
| `/push` | Sends your changes to the sandbox |
| `/pr` | Opens a draft pull request, or shows the one the thread has |
| `/autofix on` | Lets Hoplite fix failed checks and review comments on it |
| `/status` | Pull request, checks, context and cost |
| `/retry` | Runs the last message again |
| `/open` | Links to the thread, its preview and its terminal |
| `/compact` | Compacts the thread's context |

Your Hoplite skills are offered as commands too.

## With T3 Code's other agents

Any agent in T3 Code can start a Hoplite agent (`delegate_task`), in parallel and in worktrees, and gets its result back. Ask it to set `hoplite_sync` to `pull` if it should see the edits; by default they stay in Hoplite.

The other way round is off by default. **T3 Code tools** in the model options decides it: no local tools, read-only tools (default), or can start agents. Agents it starts run on your computer, and with full access nothing asks first.

## Model options

Model, reasoning (each model's own levels), speed (models with a fast tier), Changes and T3 Code tools. A model Hoplite couldn't run in your workspace says so in the picker. T3 Code's permission modes don't limit the agent: Hoplite doesn't pause cloud runs for approval. They only apply to T3 Code's own tools.

## What it fixes

| With plain `hoplite acp` | With the bridge |
| --- | --- |
| No models, only "default" | Every model, each with its own reasoning levels |
| Threads can't be resumed after a restart | They resume with their context |
| "The agent refused this request" | The real reason, such as missing credits |
| Missing credits show as signed out | They show as missing credits |
| Agent questions disappear before you answer | They stay open, and your answer continues the thread |
| Two threads started together: "Internal error" | Both run |
| Images and attached files fail | They reach the agent |
| Stop, then a new message, is refused | The new message waits its turn |
| Long tool output is cut at 2,048 characters | All of it is shown |
| An unlinked folder can run in another repository | It says it isn't linked |
| Threads are named after T3 Code's hidden instructions | They are named after your message |
| T3 Code's own tools are dropped | Its read-only tools work |
| A background check can open a sign-in page | It never does |

## Settings

Set these as environment variables on the T3 Code provider.

| Variable | Meaning |
| --- | --- |
| `HOPLITE_BIN` | Path to the `hoplite` command |
| `HOPLITE_BRIDGE_MCP` | The default for T3 Code tools: `off`, `read`, `agents`, or `write` for all of them |
| `HOPLITE_BRIDGE_HOME` | Where the bridge keeps its state (default `~/.local/share/hoplite-acp-bridge`) |

`hoplite-acp-bridge doctor` checks the installation.

## Limits

- Box size, spend limits and setup scripts are set in Hoplite: its ACP doesn't offer them.
- Requests are at most 1 MiB, so large images are shrunk and large files are refused. Pulling is limited to 2 MiB compressed.
- An answer to a question whose run has ended goes to the agent as a message; Hoplite's own page may still show the question as open.
- Your sign-in stays with the Hoplite CLI. The bridge never reads or stores it.

## Why it uses ACP and not the Hoplite API

Hoplite's ACP has what T3 Code can show, including live text, tool calls, questions, pull requests and sandbox commands, with your normal sign-in. The API needs a key created in workspace settings and would add only box size, spend limits and late answers to questions.

## Status

Tried with Hoplite CLI 3.5.2 and T3 Code main on macOS. Not yet tried with real Hoplite runs: `/pr`, `/retry`, skills, `/autofix` on an open pull request, sub-agents (checked with a scripted stand-in for Hoplite), signing in from scratch, and Linux.

`npm test` runs the tests, which need no account.

## License

MIT

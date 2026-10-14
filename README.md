# claude-plugins

The `matthewtoghill-claude-plugins` marketplace: Claude Code mods (plugins of function hooks), tested with Claude Code 2.1.291. The mods API is in early access and can change between releases.

| Plugin | What it does |
| --- | --- |
| [next-steps](./next-steps) | After each turn, Haiku suggests 1-4 next steps in a band above the prompt. Type a number (CLI) or click (Desktop) to toggle a step's prompt into your draft; `0` dismisses. Nothing is sent until you press Enter. |
| [session-replay](./session-replay) | `/replay` steps through, replays and restores every file change made in the session, grouped by prompt. |
| [test-watch](./test-watch) | Once Claude edits files, a band above the prompt counts them and offers **Run tests** (`r`). Nothing runs until you press it. Shows pass/fail, and on a failure **Fix** (`f`) puts the failing output into your draft. Vitest and Jest run only the tests related to the changed files, and **Run all** (`a`) runs the whole suite. Other projects (npm test, cargo, go, dotnet, pytest) always run the whole suite. Set the `command` option to use your own test command. |
| [cache-clock](./cache-clock) | A band above the prompt lists each prompt cache (the main thread's, and each subagent's while warm) with its TTL, a countdown to expiry, its hit rate (cache-read tokens as a share of all input tokens) and its misses (requests that read less than the request before had cached). 🟢 warm, 🟡 under a fifth of the TTL left, 🔴 cold (a coloured ● in the terminal): it says how long ago it expired and how many tokens the next message re-caches. The main thread's TTL is assumed 1h; a subagent's starts at the `ttl` option (default 5m) and switches to 1h once its cache serves a hit more than 5 minutes after its last request. The main row's **Keep warm** dropdown (1h to 6h, terminal and desktop) re-reads the main cache through a forked request a minute before it expires, until the picked time runs out; nothing is added to the transcript, but each ping is billed as a cache read of the whole context. The band's **x** closes it until the next response. |

## Install

```bash
claude plugin marketplace add matthewtoghill/claude-plugins
claude plugin install next-steps@matthewtoghill-claude-plugins
claude plugin install session-replay@matthewtoghill-claude-plugins
claude plugin install test-watch@matthewtoghill-claude-plugins
claude plugin install cache-clock@matthewtoghill-claude-plugins
```

Update with `claude plugin update <name>@matthewtoghill-claude-plugins`.

Mods run with your permissions. `claude plugin validate ./<plugin>` lists the events each one hooks and the calls it makes.

## Develop

Load a plugin from this checkout for one session:

```bash
claude --plugin-dir ./next-steps
```

Run its tests with `claude plugin test` from the plugin's folder. Bump `version` in the plugin's `.claude-plugin/plugin.json` on every release, or users keep the old copy.
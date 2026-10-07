# claude-plugins

The `matthewtoghill-claude-plugins` marketplace: Claude Code mods (plugins of function hooks), tested with Claude Code 2.1.291. The mods API is in early access and can change between releases.

| Plugin | What it does |
| --- | --- |
| [next-steps](./next-steps) | After each turn, Haiku suggests 1-4 next steps in a band above the prompt. Type a number (CLI) or click (Desktop) to toggle a step's prompt into your draft; `0` dismisses. Nothing is sent until you press Enter. |
| [session-replay](./session-replay) | `/replay` steps through, replays and restores every file change made in the session, grouped by prompt. |
| [test-watch](./test-watch) | Once Claude edits files, a band above the prompt counts them and offers **Run tests** (`r`). Nothing runs until you press it. Shows pass/fail, and on a failure **Fix** (`f`) puts the failing output into your draft. Vitest and Jest run only the tests related to the changed files, and **Run all** (`a`) runs the whole suite. Other projects (npm test, cargo, go, dotnet, pytest) always run the whole suite. Set the `command` option to use your own test command. |

## Install

```bash
claude plugin marketplace add matthewtoghill/claude-plugins
claude plugin install next-steps@matthewtoghill-claude-plugins
claude plugin install session-replay@matthewtoghill-claude-plugins
claude plugin install test-watch@matthewtoghill-claude-plugins
```

Update with `claude plugin update <name>@matthewtoghill-claude-plugins`.

Mods run with your permissions. `claude plugin validate ./<plugin>` lists the events each one hooks and the calls it makes.

## Develop

Load a plugin from this checkout for one session:

```bash
claude --plugin-dir ./next-steps
```

Run its tests with `claude plugin test` from the plugin's folder. Bump `version` in the plugin's `.claude-plugin/plugin.json` on every release, or users keep the old copy.
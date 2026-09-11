# warpline

Start your whole project with one command. Warpline saves a project's working context — its directory, its dev processes, their order, and its environment — under one memorable name.

```bash
warpline up myapp
```

That brings up the database, waits until it actually accepts connections, runs migrations, waits for those to finish, starts the API, waits for its health endpoint to answer, then starts the web server. All output lands in one prefixed stream. `Ctrl-C` shuts everything down in reverse order.

Terminal-native, tmux-free, cross-platform. No daemon to install, no account, no cloud. State is local JSON in `~/.warpline/`.

## Install

```bash
npm install -g warpline
```

Node 18.17 or newer. Two small runtime dependencies (`yaml`, `picocolors`).

Optional, so `warpline cd` can actually move your shell:

```bash
# bash
echo 'eval "$(warpline shell-init --shell bash)"' >> ~/.bashrc

# zsh
echo 'eval "$(warpline shell-init --shell zsh)"' >> ~/.zshrc

# fish
warpline shell-init --shell fish > ~/.config/fish/conf.d/warpline.fish

# PowerShell
warpline shell-init --shell powershell >> $PROFILE
```

That also installs tab completion for commands and saved project names.

## Quick start

```bash
cd ~/code/myapp
warpline init      # inspects the repo, writes warpline.yml
warpline up        # starts everything
```

`warpline init` reads your `package.json` scripts, lockfile, `docker-compose.yml`, `Procfile`, workspace layout, and `.env.example`, then proposes a config. It knows default ports and readiness signals for roughly two dozen frameworks, so the generated file usually needs no edits.

After that, from any directory:

```bash
warpline up myapp        # start
warpline status myapp    # what's running, with live port checks
warpline logs myapp -f   # follow output
warpline down myapp      # stop
```

## Why not just an alias

For one project with one `npm run dev`, an alias is genuinely fine. Warpline earns its place once a project has more than one moving part.

- **Ordering that actually works.** `needs:` plus a readiness probe means "start this once the thing it depends on is answering," not "start this five seconds later and hope."
- **Port pre-flight.** Before starting anything, Warpline checks the ports your processes will bind and tells you *which* process holds one that's taken. A confusing `EADDRINUSE` three seconds into startup becomes one clear message up front.
- **One log stream.** Colour-coded aligned prefixes, plus a per-process log file on disk so `warpline logs` works after the fact.
- **Environment without footguns.** Warpline never copies secret values into its own state. It records which files to load and resolves them at start time.
- **Honest process lifecycle.** `status` verifies PIDs against the OS instead of trusting a stale file, and `down` stops things in reverse dependency order.

## Configuration

`warpline.yml` lives in your repo and is meant to be committed. That is deliberate: the config gets code-reviewed, travels with the branch, and a teammate who clones the repo can run `warpline up` without any setup of their own.

The global index in `~/.warpline/` only maps names to directories. All behaviour lives in the project file.

```yaml
name: myapp

note: "run pnpm db:migrate after pulling"

env:
  # Loaded in order, later files win. Only these paths are stored, never values.
  files: [.env, .env.local]
  # Refuse to start if any of these end up empty.
  require: [DATABASE_URL, STRIPE_KEY]
  # Literal, non-secret values.
  vars:
    NODE_ENV: development

hooks:
  before: "docker compose up -d"
  cleanup: "docker compose stop"

processes:
  db:
    command: docker compose up postgres
    ready: { port: 5432 }

  migrate:
    command: pnpm db:migrate
    kind: task              # runs to completion; ready means exit 0
    needs: [db]

  api:
    command: pnpm dev
    cwd: services/api
    port: 4000
    needs: [migrate]
    ready: { http: "http://localhost:4000/health" }
    restart: on-failure

  web:
    command: pnpm dev
    cwd: apps/web
    port: 3000
    needs: [api]
    ready: { log: "ready in" }
    open: true              # open the browser once it is actually ready

  mailhog:
    command: docker compose up mailhog
    optional: true          # skipped unless you ask for it
```

### Shorthands

A process that only needs a command:

```yaml
processes:
  web: pnpm dev
```

An `env:` block with no reserved keys is treated as literal variables:

```yaml
env:
  NODE_ENV: development
```

`ready:` accepts a bare port or URL, and `false` opts out of gating:

```yaml
ready: 3000
ready: "http://localhost:3000/health"
ready: false
```

### Readiness probes

Declare one signal per process. This is what makes `needs:` mean something.

| Probe | Ready when |
| --- | --- |
| `port: 5432` | Something accepts TCP connections on that port |
| `http: "url"` | The URL responds. `status: 299` tightens the accepted ceiling (default 499, so a 404 still counts as up) |
| `log: "pattern"` | A case-insensitive regex matches the process output |
| `file: "path"` | The path exists |
| `delay: 2000` | A fixed number of milliseconds has passed |
| *(omitted)* | The process has stayed alive for 400ms |

All probes accept `timeout` (default 90000) and `interval` (default 250).

### Process fields

| Field | Default | Notes |
| --- | --- | --- |
| `command` | *required* | Run through the platform shell |
| `cwd` | project root | Relative to the root, and must stay inside it |
| `kind` | `service` | `task` runs to completion and gates dependents on exit 0 |
| `needs` | `[]` | Process names that must be *ready* first |
| `port` / `ports` | — | Used for pre-flight checks. A single `port` is also injected as `PORT` |
| `ready` | settle 400ms | See above |
| `env` | `{}` | Extra variables for this process only |
| `restart` | `on-failure` (`no` for tasks) | Also `always` or `no` |
| `maxRestarts` | `3` | Exponential backoff from `backoff` (default 500ms), capped at 30s |
| `open` | — | `true` uses the declared port, or give an explicit URL |
| `optional` | `false` | Excluded from a bare `warpline up` |
| `stopTimeout` | `8000` | Grace period before escalating to a hard kill |
| `label` | the name | Used in log prefixes |
| `shell` | platform default | Override the interpreting shell |

### Environment resolution

Layers, lowest precedence first:

1. The inherited shell environment
2. `env.files`, in declaration order
3. `env.vars`
4. A process's own `env`
5. `--env KEY=VALUE` on the command line

Values expand against the accumulated result, so `DATABASE_URL=postgres://localhost:${PG_PORT}/app` works if `PG_PORT` came from an earlier layer. `${VAR:-default}` and `\$` escaping are supported.

Set `env.isolate: true` to start from a minimal platform baseline instead of inheriting everything, then allowlist what you need with `env.passthrough`.

`warpline env` shows the result and where each value came from, with secret-looking keys redacted:

```
VARIABLE      VALUE                 FROM
DATABASE_URL  postgres://...        .env
NODE_ENV      development           warpline.yml env.vars
STRIPE_KEY    ******** (32 chars)   .env.local
```

## Commands

| Command | What it does |
| --- | --- |
| `warpline init` | Inspect the current directory and write `warpline.yml` |
| `warpline up [name]` | Start a project |
| `warpline down [name]` | Stop it, in reverse dependency order |
| `warpline restart [name]` | Stop then start |
| `warpline status [name]` | What is running, verified against the OS |
| `warpline list` | Saved projects, most recent first |
| `warpline logs [name]` | Show or follow captured output |
| `warpline exec [name] -- cmd` | Run a one-off command with the project's cwd and env |
| `warpline env [name]` | Show the resolved environment and its provenance |
| `warpline cd <name>` | Jump to a project (needs `shell-init`) |
| `warpline link [name]` | Register the current directory under a name |
| `warpline remove <name>` | Forget a name. Never touches your files |
| `warpline rename <old> <new>` | Rename a saved project |
| `warpline note [name] ["text"]` | Attach a reminder shown on every start |
| `warpline doctor [name]` | Check everything that commonly breaks a start |
| `warpline prune` | Clean up dead index entries and stale state |
| `warpline shell-init` | Emit shell integration and completions |

Aliases: `resume` and `start` for `up`, `stop` for `down`, `ps` for `status`, `ls` for `list`, `rm` for `remove`.

### Useful flags

```bash
warpline up --dry-run              # show the start plan, run nothing
warpline up --detach               # background; returns once everything is ready
warpline up --only web             # just web, plus whatever it depends on
warpline up --except mailhog       # everything but this
warpline up --kill-port            # free a blocked port first (asks before killing)
warpline up --keep-going           # do not tear everything down when one fails
warpline up --restart              # stop it first if already running
warpline up --env DEBUG=1          # extra environment values
warpline up --no-prefix -T         # raw lines, with timestamps

warpline status --all --json       # machine-readable, every project
warpline logs api -n 200           # last 200 lines of one process
warpline down --all                # stop every running project
warpline down --orphans            # recover supervisors warpline lost track of
warpline list --names              # bare names, for scripts and fzf
```

### Names are fuzzy

`warpline up myproj` matches `myproject`. Exact matches win, then prefixes, then subsequences, then near-misses by edit distance. When two candidates are genuinely equally good, Warpline asks instead of guessing.

## warpline doctor

The command to reach for when a project that used to start no longer does. It checks:

- Process directories still exist
- Package scripts referenced by your commands still exist (a renamed script is a top cause of silent breakage)
- Command binaries resolve on `PATH`
- Declared env files are present, and required variables are non-empty
- Keys in `.env.example` that are not set in your actual environment
- `node_modules` exists and is not older than the lockfile
- Your Node version matches `.nvmrc`, `.tool-versions`, or `engines.node`
- Declared ports are free
- The dependency graph has no cycles
- The global index still points at the right directory

Exits non-zero on problems, so it works in CI. `--strict` also fails on warnings.

## How it works

```
~/.warpline/
  registry.json            name -> project directory
  state/<name>.json        live PIDs, statuses, ports
  logs/<name>/<proc>.log   captured output, rotated at 8MB
  run/                     detached supervisor logs
```

**Resume means relaunch, not reattach.** PIDs do not survive a reboot, so Warpline stores commands and directories rather than process handles. What it does keep is enough live state to notice a project is already running and adopt it instead of starting a second copy.

**Foreground and detached.** By default `warpline up` holds the terminal and multiplexes logs; `Ctrl-C` shuts everything down in reverse dependency order. With `--detach`, Warpline spawns a supervisor that owns the process tree, waits until everything reports ready, then returns your prompt. `status`, `logs`, and `down` work the same either way.

**Process trees.** `npm run dev` is a shell that spawns npm that spawns node. Signalling only the shell leaves the real server orphaned on its port. On POSIX, Warpline puts each process in its own process group and signals the group. On Windows it uses `taskkill /T`. Either way it tries a graceful stop first and escalates to a hard kill only after the grace period.

## Platform notes

Developed and tested on Windows, and written to behave the same on macOS and Linux. Two honest differences:

- **Windows `Ctrl-C`** reaches child processes directly, because attaching them to the console is the only way to capture their output there. Warpline still runs its shutdown sequence, but children may exit slightly before their turn. `warpline down` from another terminal gives the strictly ordered shutdown.
- **Windows graceful stops** are best-effort. `taskkill` without `/F` sends a close request that console programs like node generally ignore, so Warpline waits briefly and then forces. Seeing `force killed` on Windows is normal, not a failure.

If `~/.warpline/state` is deleted while a detached project is running, that supervisor becomes invisible to `status`. `warpline down --orphans` scans the OS process table and cleans it up.

## Not in scope

- **tmux pane and window layouts.** [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) does that well, and doing it properly means being tmux-only. Warpline deliberately works in any terminal.
- **Cloud sync and accounts.** Local files only. Your config already syncs, because it lives in your repo.

## Prior art

Warpline is closest to [tmuxinator](https://github.com/tmuxinator/tmuxinator) — named per-project configs that launch defined commands — minus the tmux dependency, plus readiness gating and environment handling. It overlaps with [overmind](https://github.com/DarthSim/overmind) and `hivemind` for Procfile-style multi-process launch, `mprocs` for the multiplexed view, `direnv` for per-directory environments, and `zoxide` for jump-by-name. Warpline's angle is combining those concerns behind a single project name, installable from npm, behaving the same in every terminal on every platform.

## Programmatic use

The internals are exported if you want to build on them:

```ts
import { loadConfigFrom, Supervisor, ProcessLogger } from 'warpline';

const config = loadConfigFrom(process.cwd());
const logger = new ProcessLogger({ projectName: config.name, toConsole: true, prefix: true });
const supervisor = new Supervisor({
  config,
  projectName: config.name,
  processes: config.processes,
  mode: 'foreground',
  logger,
});

const outcome = await supervisor.start();
```

## Development

```bash
npm install
npm run build
npm run typecheck   # src and tests
npm test            # unit tests
npm run test:watch  # re-run on change
node dist/bin.js --help
```

Point `WARPLINE_HOME` at a scratch directory to avoid touching your real state while developing. `WARPLINE_DEBUG=1` prints stack traces, and `WARPLINE_ASCII=1` forces ASCII output.

## License

MIT

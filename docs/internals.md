# Inside Claude Code for VS Code

A teardown of version **2.1.233** (`anthropic.claude-code-2.1.233-win32-x64`); still current through **2.1.258**. 2.1.234's bundle was byte-for-byte the same shape. 2.1.235's was not — the session list's `useState` alias moved from `ne` to `ie` — and neither was 2.1.238's, which renamed the same component's `useRef` alias from `ge` to `_e` (both under "Content search reuses the session-list handoff" below). 2.1.239 broke a third — injection point #4, on the `$`-in-an-identifier trap that #6–#9 already carry a warning about (see "The session is not reachable from the context object"). Everything else held: all eight signatures match 2.1.239 with those captures generalised and nothing else touched, and 2.1.241 needed no change at all — every signature matched it as written, and its own diff against 2.1.239 is an onboarding-checklist entry and two strings. 2.1.245 broke two more, for a reason with no precedent in this file: it is the first release to put `$`-prefixed names into `extension.js`, which cost #2 its `\w+` identifier classes and #1 its literal anchor outright (see "CSP and loading your own script"). 2.1.246 cost nothing again, which is worth saying out loud because it is the release that deleted the whole model catalogue from `extension.js` — `provider_ids`, `knowledge_cutoff`, `effort_cost_index` and every `display_name` are gone from the extension and live only in the CLI binary now (see "The CLI does not remap `claude-fable-5`"). Nothing here reads them, so nothing moved. 2.1.247 cost nothing either — three releases in a row now — and its own diff is git-invocation hardening, a usage-limit grace banner behind an experiment gate (see "The usage-limit banner has a second tenant") and two spinner-tips settings. 2.1.250 cost nothing either — four in a row — and its diff is thinner still: one CLI setting (`desktopSessionCleanupPeriodDays`), one string in `extension.js` ("telemetry is off") and one new webview block that recognises the CLI's own model-switch notices — "Set model to ", "Kept model as ", "Current model: ", "Fast mode ON · model set to" and two cloud-switch failures — so it can strip their backticks before rendering. That block reads the transcript text claudapter also reads, but it only reformats stock messages; nothing it touches is written by this project. 2.1.251 cost nothing either — five in a row — and is thinner again: no new commands, VS Code settings, CLI settings keys or webview actions, one new string in `extension.js` (`"Private Key"`, the label on a `private-key` rule in the secret scanner) and none at all in the webview. Injection point #3 renamed two of its locals (`N.env=F;` → `N.env=D;`), which the structural signature absorbs without a change. 2.1.252 cost nothing either — six in a row — and is the thinnest release recorded here: both bundles are the same length as 2.1.251's to the byte and differ in seven single-character runs, every one of them a version string (six in `extension.js`, including the SDK's own `0.3.251` → `0.3.252`, and one in the webview's footer). Not an identifier moved, and the settings schema differs only in its `$comment` generation timestamp. The whole release is the CLI binary, 46,592 bytes larger, whose only new settings key is `scratchpadDirectory` — an environment-block field naming a temp directory for the agent to use instead of `/tmp` (see "The CLI does not remap `claude-fable-5`"). 2.1.257 ends that run and is the largest release recorded here since 2.1.245: archived sessions, unread markers, session groups reachable from the tab, an output-style picker and a slash-command browser, three new commands (`markSessionUnread`, `renameSessionTab`, `addSessionTabToGroup`), two new webview actions (`output-style`, `browse-slash-commands`) and four new CLI settings (`timeFormat`, `timeZone`, `permissions.blockReadsOutsideWorkingDirectories`, `modelPicker.options[].behavesAs`). It cost exactly one signature — the spanning one, #7 — and split it in two (see "Pinning is a sort, not a DOM move"), taking the injection count from eight to nine. It is also the first release to ship something claudapter already does: the session list now partitions open sessions to the front by itself. 2.1.258 is the opposite kind of release, and an exact repeat of 2.1.252: both bundles are the same length as 2.1.257's to the byte and differ in seven single-character runs, every one of them a version string — six in `extension.js`, including the SDK's own `0.3.257` → `0.3.258`, and one in the webview's footer — while the settings schema differs only in its `$comment` generation timestamp. Not an identifier moved, and all nine signatures matched as written. So the rest was not re-verified line by line. Everything below comes from the bundle itself: line numbers refer to a formatted `extension.js` (`prettier 3.x --parser babel`, 143,324 lines), signatures to the minified original. Minified identifiers are renamed on nearly every release — they are quoted to make a spot findable, not as stable names.

## Package contents

| File | Size | What it is |
|---|---:|---|
| `resources/native-binary/claude.exe` | 304 MB | the CLI itself — bun standalone + Authenticode |
| `webview/index.js` | 4.7 MB | UI: React 18.3.1, marked, parts of monaco |
| `extension.js` | 2.7 MB | the extension host (bun bundle) |
| `webview/index.css` | 378 KB | UI styles |
| `resources/audio-capture/*/audio-capture.node` | 498 KB | native module for dictation |

## Two activation paths

`activate()` (`thr`, line 142918) brings up two independent things:

1. **Native UI** — the webview/session manager (class `rZ`, line 139511): providers `claudeVSCodeSidebar`, `…SidebarSecondary`, `claudeVSCodeSessionsList`, the `claudeVSCodePanel` panel, 23 contributed commands, a status bar item, and the `_claude_vscode_fs_left/right/readonly` FS providers used for diffs.
2. **IDE MCP server** (tool registration `zNe`, line 142549; listener `BNe`, line 142827 — lines 142549–142861) — what a terminal-launched CLI talks to: HTTP+WebSocket on `127.0.0.1`, authorization via the `x-claude-code-ide-authorization` header (a random UUID), a lock file and the `CLAUDE_CODE_SSE_PORT` handoff.

MCP server tools: `openDiff`, `getDiagnostics`, `close_tab`, `closeAllDiffTabs`, `openFile`, `getOpenEditors`, `getWorkspaceFolders`, `getCurrentSelection`, `getLatestSelection`, `checkDocumentDirty`, `saveDocument`, `executeCode` (Jupyter). Notifications: `diagnostics_changed`, `log_event`.

## How Claude is launched

The extension embeds **Claude Agent SDK 0.3.232** (the same version published on npm as `@anthropic-ai/claude-agent-sdk`) and calls `query()` with a transport pointing at `claude.exe`:

```
--output-format stream-json --verbose --input-format stream-json
```

`spawnClaude` (line 138141, in class `fs` at line 137881) assembles the options:

- `systemPrompt: { type: "preset", preset: "claude_code", append: … }`
- `settingSources: ["user", "project", "local"]`
- `enableFileCheckpointing: true`
- hooks: `PreToolUse` — `Edit|Write|MultiEdit` (baseline snapshot) and `Edit|Write|Read` (autosave); `PostToolUse` — diagnostics collection
- `extraArgs: { debug, debug-to-stderr, enable-auth-status, no-chrome, replay-user-messages }`
- env: `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, `MCP_CONNECTION_NONBLOCKING=true`, `CLAUDE_CODE_ENABLE_TASKS=0`

The environment comes from `Dm()` (line 139477): `process.env` plus the `claudeCode.environmentVariables` setting. **It is frozen at spawn time** — a provider cannot be swapped inside a live process, the channel has to restart.

The assignment, minified, is injection point #3 (line 138215 formatted):

```js
f.pathToClaudeCodeExecutable=m,f.executableArgs=g,f.env=v;
```

Every identifier there is a minified local, and the minifier reshuffles them release to release — six spellings across eleven releases:

| Release | Assignment | Terminator |
|---|---|---|
| 2.1.220 | `f.env=w,g)` | `,<nodePath>)` |
| 2.1.221–2.1.223 | `f.env=x,_)` | `,<nodePath>)` |
| 2.1.224 | `f.env=b,g)` | `,<nodePath>)` |
| 2.1.226 | `f.env=x,g)` | `,<nodePath>)` |
| 2.1.227 | `f.env=b;` | `;` |
| 2.1.228 | `f.env=v;` | `;` |
| 2.1.229 | `f.env=v;` | `;` |
| 2.1.231–2.1.235 | `f.env=v;` | `;` |
| 2.1.238–2.1.241 | `h.env=y;` | `;` |
| 2.1.245 | `q.env=Z;` | `;` |
| 2.1.246 | `N.env=D;` | `;` |
| 2.1.247–2.1.250 | `N.env=F;` | `;` |
| 2.1.251–2.1.252 | `N.env=D;` | `;` |
| 2.1.257–2.1.258 | `N.env=L;` | `;` |

2.1.227 is the one that changed the **shape**, not just the names. Up to 2.1.226 the three assignments were the condition of an `if`, with the node path as the last operand of the comma expression:

```js
if(f.pathToClaudeCodeExecutable=m,f.executableArgs=h,f.env=x,g)f.executable=g;
```

`resolveClaudeBinary()` used to fall back to `resources/claude-code/cli.js` run under `process.execPath`, and `nodePath` carried that interpreter. 2.1.227 dropped the fallback — the returned object is now just `{pathToClaudeCodeExecutable, executableArgs, env}` — and the whole `if(…)` wrapper went with it, leaving a bare comma-expression statement. Corroborating counts, 2.1.226 → 2.1.227: `nodePath` 3 → 1, `f.executable=` 1 → 0, `process.execPath` 2 → 0, `"cli.js"` 1 → 0. No behavioural loss on a Windows install: neither version ships `resources/claude-code/`, so that branch never fired.

A literal signature breaks on almost every update, and a structural one that assumes the `if` breaks here. Capturing the terminator whole and re-emitting it verbatim covers both shapes:

```js
/(\w+)\.pathToClaudeCodeExecutable=(\w+),\1\.executableArgs=(\w+),\1\.env=(\w+)(,\w+\)|;)/
```

One match in every release from 2.1.220 to 2.1.227. The terminator must stay *inside* the capture and be echoed unchanged — a character class like `[,;]` would match all seven too, but re-emitting only `;` would swallow the `g)` on the older bundles and produce an unbalanced `if(`.

The back-reference pins all three assignments to the same options object, and the resume session id is read back off that object (`resume:t` in the literal) rather than from the `spawnClaude` parameter, which is renamed just as often.

## The webview ↔ host protocol

Request/response with a `channelId`; dispatch lives in `processRequest` on the base class `lL` (line 127031, `processRequest` at 128070) with roughly 90 message types, and the session class `fs` overrides it (line 138069) for the handful it handles itself. The host sends `{type:"from-extension", message}` to the UI; the process stream arrives as `{type:"io_message", channelId, message, done}`.

Messages from the webview that matter to a patcher:

| Message | Carries | Used for |
|---|---|---|
| `launch_claude` | `channelId, cwd, resume, permissionMode, thinkingLevel` | intercepted right before the spawn to inject the profile |
| `close_channel` | `channelId` | clean process shutdown before a restart |
| `request.update_session_state` | `sessionId, state, title` | a **weak** hint of the tab's session — see below |
| `request.rename_tab` | `title, hasPendingPermissions, hasUnseenCompletion` | overwrites the tab title and icon |

### Two sources of the session id, and only one is safe to resume

The id a tab is *really* on is announced by the CLI itself: `system/init` in the `io_message` stream carries `session_id`, and `host.js` reads it by wrapping `webview.postMessage`. That is the **strong** source: the CLI has written that session, so it can be bound to a profile and handed back as `--resume`.

`update_session_state` also carries a `sessionId`, and it arrives earlier — but it is a **weak** source, for two reasons. It is emitted once more for the session that just *stopped* being active, so it can name a neighbouring tab. And on a tab that has not sent anything yet the page already holds a provisional id per channel: the CLI has written nothing under it, and resuming it is answered with `No conversation found with session ID …`. That was a real failure (2.1.233, five phantom `codex` bindings in `bindings.json`, all born this way): the host already refused to *bind* on a weak id, but it still echoed it in `ccx:state`, the page adopted it as `state.sessionId`, and `ccx:apply` handed it straight back as the id to resume.

So a weak id is kept on the host only — it still resolves the profile and the models — and never travels to the page: `stateFor` sends `sessionId: null` while `__ccxSessionWeak` is set, and `restartChannel` in the page resumes only from what the channel itself announced or was launched with, never from `state.sessionId`. A switch on a tab with nothing said in it therefore restarts **fresh** (the toast says so), and the first `system/init` binds the real session to the profile that was chosen. Nothing is lost, because there was nothing to keep.

**And even the strong source is early.** `system/init` proves the CLI *minted* the id, not that it *wrote* it: the transcript `<projects>/<slug>/<sessionId>.jsonl` appears on the first user turn. A session that is launched and dies before anyone types leaves an announced id and no file — and the extension's own `launchClaude()` passes `this.sessionId.value` on every relaunch of that tab, so from then on every restart repeats `--resume=<id>` → "No conversation found". Seven ids in the log had been launched that way (five of them from the weak path above, two from this one). Neither signal can decide this; the disk can. So `envFor` gets the options object as a third argument (injection point #3 now reads `envFor(env, opts.resume, opts)`) and clears `opts.resume` unless the transcript exists — the SDK builds `--resume=${w}` from that field after the assignment has run, so the spawn simply starts fresh. The check scans every project folder, because the id is unique and the slug is not ours to reconstruct.

## Traps found while patching

### `rename_tab` overwrites the icon

The handler (line 138094) **unconditionally** rewrites both title and icon:

```js
this.panelTab.title = e.request.title;
let r;
if (e.request.hasPendingPermissions) r = "claude-logo-pending.svg";
else if (e.request.hasUnseenCompletion) r = "claude-logo-done.svg";
else r = "claude-logo.svg";
this.panelTab.iconPath = ge.Uri.file(On.join(this.context.extensionPath, "resources", r));
```

It fires on every title change, so an icon set once gets wiped. The fix is to intercept the `iconPath` setter on the panel object and substitute all three stock logos — letting `claude-logo-done.svg` through would replace the provider icon with the stock one the moment a message arrives.

The two indicator variants are just the logo with a hole punched in the corner and a dot dropped into it (`cx=19.5 cy=4.5`, hole `r=6.5`, dot `r=4.5`, `#D97757` for done and `#3B82F6` for pending). The hook repeats that geometry over the profile icon and caches the result in `~/.claude/claudapter/icons/badged/<profile>-<state>.svg`, so the brand and the indicator both survive. The profile icon is embedded as a `data:` URI rather than referenced by path: a tab icon is painted as a CSS background, and an SVG in that mode may not load external resources.

The state the extension last asked for is remembered on the panel (`__ccxIconState`), because `decorate()` also repaints the icon on profile changes and would otherwise reset the indicator.

The hook is installed at the first `iconPath` assignment in `setupPanel` (line 139865) — injection point #2. It carries the same minified-name problem as #3, and 2.1.226 is where it bit: `light:a,dark:a` became `light:s,dark:s` and the literal signature stopped matching. The structural form anchors on the shape and on the `.webview.options=` that always follows, which is also what keeps the panel variable available — the injected call needs that one name:

```js
/(\w+)\.iconPath=\{light:(\w+),dark:\2\},(\1\.webview\.options=)/
```

### An existing session's panel cannot be reopened

`createPanel` (line 139803):

```js
createPanel(e, t, r) {
    if (e) {                              // e = sessionId
        let a = this.sessionPanels.get(e);
        if (a) {
            if ((a.reveal(), t))          // t = a prompt to seed — silently dropped
                It.window.showInformationMessage(
                    "Session is already open. Your prompt was not applied — enter it manually.",
                );
            return { startedInNewColumn: !1 };   // does NOT create a new panel
        }
    }
```

So `claude-vscode.editor.open` with a live `sessionId` only reveals the existing panel, and any prompt handed to it is dropped with a notice. The panel's `onDidDispose` (line 139941) does drop the entry from `sessionPanels`, so a *closed* session reopens cleanly — but there is no path that gives you a second panel on a session that is still open. The working approach for a provider switch is to restart the channel, not the panel.

### Channel shutdown is asynchronous

`close_channel` does not complete instantly: roughly 0.5 s pass between "Closing Claude on channel" and the channel actually being freed. Sending `launch_claude` on a timer before that returns `Channel already exists`, after which the host finishes killing the channel and the tab is left without a process (`Channel not found for io_message`). The trigger must be the **incoming** `close_channel`, not a timeout.

### Two host-kind lists, and only one of them matters

The CLI layers `~/.claude/settings.json`'s `env` block over the spawn environment and only filters
provider keys for hosts it treats as managed. That gate is `bIc` in the CLI bundle:

```js
bIc = new Set(["claude-desktop", "claude-desktop-3p", "local-agent"]);
function rj() { let e = J.CLAUDE_CODE_ENTRYPOINT; return e !== void 0 && bIc.has(e) }
```

`claude-vscode` is not in it, so nothing is filtered for the VS Code spawn and whatever sits in that
`env` block silently outranks the per-tab profile. `host.js` warns about that on a switch rather than
editing the user's file.

The trap is that the bundle keeps growing *other* entrypoint sets, and three of them now do contain
`claude-vscode`. By 2.1.229 there are four in total, and only the first is the settings filter:

| Set | Members | What it actually gates |
|---|---|---|
| `BLc` (`bIc` in 2.1.228) | desktop, desktop-3p, local-agent | **the settings.json env filter** — no `claude-vscode` |
| `nRs` (`xFa` in 2.1.228) | desktop, local-agent, vscode | delegating OAuth token refresh to the host |
| `AsS` — new in 2.1.229 | vscode, desktop, desktop-3p | deletes `CLAUDE_CODE_ENTRYPOINT` from a child env |
| `t1_` — new in 2.1.229 | vscode | whether disabled models are listed in the picker |

`AsS` is the dangerous lookalike: same three-member shape as `BLc`, two members in common, and it
does include `claude-vscode`. It is a different function entirely. Resolve these by their *use site*,
never by membership — grepping for `claude-desktop` and eyeballing the arrays gives the opposite
answer. Through 2.1.229 the settings filter is still `BLc`, consulted via `wj()`, and still excludes
`claude-vscode`, so the warning stands.

### The CLI does not remap `claude-fable-5` (2.1.232, still in 2.1.252)

Fable shipped as a model but not as a *family* in the two places the CLI remaps a requested model onto
the `ANTHROPIC_DEFAULT_*_MODEL` env vars. In `resources/native-binary/claude.exe`:

```js
function t5p(e){let t=Vw(e)?.family,
  r={opus:X.ANTHROPIC_DEFAULT_OPUS_MODEL,sonnet:X.ANTHROPIC_DEFAULT_SONNET_MODEL,haiku:X.ANTHROPIC_DEFAULT_HAIKU_MODEL},
  n=t!==void 0&&Object.hasOwn(r,t)?r[t]:void 0; …}
function Rci(e){if(e.startsWith("sonnet"))return"sonnet";if(e.startsWith("opus"))return"opus";if(e.startsWith("haiku"))return"haiku";return}
```

Neither `t5p`'s `r` object nor `Rci`'s prefix match knows `fable`, even though the model exists
elsewhere (`latest_per_family:{fable:"claude-fable-5", …}`). So `claude-opus-5` / `claude-sonnet-5` /
`claude-haiku-4-5` remap everywhere, but `claude-fable-5` only remaps through the adapter's
`profileModelRules` — i.e. only for profiles routed through `127.0.0.1:8787` (codex/openai). Direct
providers (`qwen`, `deepseek`, `glm`, `minimax`) send `claude-fable-5` verbatim and get a 400.

Decision: not worked around — waiting on an upstream fix. Re-check both sites in the CLI bundle on
each version bump; the day `fable:` appears in that `r` object, the direct providers recover it for free.

2.1.246 is where this got easier to check and no closer to fixed. The extension stopped shipping its
own copy of the catalogue entirely — `claude-opus` occurrences in `extension.js` fell 177 → 35, every
`display_name`, `provider_ids`, `knowledge_cutoff` and `effort_cost_index` went to zero, and the CLI
binary is the only place any of it exists now. Both remap sites survived the move unchanged, under
new minified names (`t5p` → `EPn`, and `Rci` is now the `l` beside the family table):

```js
function EPn(e){let t=nP(e)?.family,
  n={opus:V.ANTHROPIC_DEFAULT_OPUS_MODEL,sonnet:V.ANTHROPIC_DEFAULT_SONNET_MODEL,haiku:V.ANTHROPIC_DEFAULT_HAIKU_MODEL}, …}
function R(e){return{sonnet:{envVarPriority:["ANTHROPIC_DEFAULT_SONNET_MODEL"],defaultKey:E},
  opus:{envVarPriority:["ANTHROPIC_DEFAULT_OPUS_MODEL"],defaultKey:e},
  haiku:{envVarPriority:["ANTHROPIC_SMALL_FAST_MODEL","ANTHROPIC_DEFAULT_HAIKU_MODEL"],defaultKey:M}}}
function l(e){if(e.startsWith("sonnet"))return"sonnet";if(e.startsWith("opus"))return"opus";if(e.startsWith("haiku"))return"haiku";return}
```

Still three families in all three places, still no `fable`, even though `ANTHROPIC_DEFAULT_FABLE_MODEL`
has been a recognised settings key since well before this release (58 hits in the 2.1.245 binary) and
`latest_per_family` still names `fable:"claude-fable-5"` right beside the three that do remap. The gap
is in the family tables, not in the catalogue, so the move changes nothing about the workaround status:
direct providers still get `claude-fable-5` verbatim.

Re-checked on the 2.1.247 binary, and again on 2.1.250 (226,715,296 bytes, now read out of the cached
VSIX at `…/CachedExtensionVSIXs/anthropic.claude-code-2.1.250-win32-x64!extension/resources/native-binary/claude.exe`).
Both sites are still there and still three families wide — one
`{opus:<X>.ANTHROPIC_DEFAULT_OPUS_MODEL,sonnet:<X>.…,haiku:<X>.…}` object (one hit in the whole binary) and one
`startsWith` chain, with `startsWith("fable")` at zero hits anywhere in the file:

```js
function ct(e){let t=dc(e)?.family,r={opus:a.ANTHROPIC_DEFAULT_OPUS_MODEL,sonnet:a.ANTHROPIC_DEFAULT_SONNET_MODEL,haiku:a.ANTHROPIC_DEFAULT_HAIKU_MODEL}, …}
function l(e){if(e.startsWith("sonnet"))return"sonnet";if(e.startsWith("opus"))return"opus";if(e.startsWith("haiku"))return"haiku";return}
```

The names moved again (`EPn` → `ct`, `nP` → `dc`, the family object's holder `V` → `a`); the shapes did not.
`latest_per_family` still names `fable:"claude-fable-5"` and `ANTHROPIC_DEFAULT_FABLE_MODEL` is still a
recognised settings key — 34 hits in both 2.1.247 and 2.1.250, down from 58 in 2.1.245, which is the
catalogue move taking dead copies with it rather than the key going away. Nothing to change.

Re-checked again on 2.1.251, this time straight out of the extension folder rather than the VSIX cache — the
binary ships at `resources/native-binary/claude.exe` and is 217,360,032 bytes, 9,355,264 fewer than 2.1.250's.
Both sites survive: the family object still has exactly one hit in the whole binary and the `startsWith` chain
one, both still three families wide, `startsWith("fable")` still at zero hits anywhere in the file. The names
moved again (`ct` → `ut`, `dc` → `Zl`; the family object's holder is still `a`), the shapes did not:

```js
function ut(e){let t=Zl(e)?.family,r={opus:a.ANTHROPIC_DEFAULT_OPUS_MODEL,sonnet:a.ANTHROPIC_DEFAULT_SONNET_MODEL,haiku:a.ANTHROPIC_DEFAULT_HAIKU_MODEL}, …}
function l(e){if(e.startsWith("sonnet"))return"sonnet";if(e.startsWith("opus"))return"opus";if(e.startsWith("haiku"))return"haiku";return}
```

`ANTHROPIC_DEFAULT_FABLE_MODEL` is at 35 hits, one more than 2.1.247 and 2.1.250, and `latest_per_family` still
reads `{fable:"claude-fable-5",opus:"claude-opus-5",sonnet:"claude-sonnet-5",haiku:"claude-haiku-4-5"}`. Nothing
to change.

2.1.252's binary is 217,406,624 bytes, 46,592 more than 2.1.251's, and is the whole of that release — the two
bundles carry nothing but their own version string. Every count that matters is unmoved: `ANTHROPIC_DEFAULT_FABLE_MODEL`
35, `latest_per_family` 5, `ANTHROPIC_DEFAULT_OPUS_MODEL` 55, `ANTHROPIC_BASE_URL` 83, `ANTHROPIC_AUTH_TOKEN` 57,
`startsWith("fable")` still 0. `ut` and `Zl` kept their names — only their neighbours moved (`Dte` → `Mte`, `GP` → `VP`,
`jzt` → `zzt`) — and the family object is still three families wide. Not one human-readable string in the binary changed
(2,569 before and after, no additions, no removals); the only new identifier-shaped tokens are a build hash and
`scratchpadDirectory`, a field appended to the environment block of the system prompt:

```js
function Gue({cwd:e,additionalWorkingDirectories:t}){ … return{workingDirectory:e,isWorktree:…,isGitRepo:r,
  additionalWorkingDirectories:[...t??[]],platform:a.platform,shell:q$e(),osVersion:o,...u&&{scratchpadDirectory:u}}}
function V$e(e){return`Scratchpad directory: ${e} — always use it for temporary files … instead of `/tmp``}
```

It is suppressed for background sessions (`CLAUDE_CODE_SESSION_KIND==="bg"`), and a companion notice —
"The scratchpad directory announced earlier is no longer available; use it no further." — covers it going away
mid-session. Nothing there touches a provider, an endpoint or a credential. Nothing to change.

### The session is not reachable from the context object

Injection point #4 used to hand over only the command registry: `onRegistry(n, b)`. That is enough for
the menu entry, but not for anything that has to *talk to the conversation* — `send()`, `messages`,
`busy` and `lastServedModel` all live on the session, which is a different class (`MX`) from the
context object the registry hangs off (`t_e`). Enumerating `t_e` settles it: forty-odd members,
`forkConversation` and `renameTab` among them, and nothing session-shaped at all. So `ctx.activeSession`
— the obvious-looking read — is permanently `undefined`, and anything gated on it silently does nothing.
That is exactly how the compaction offer shipped broken: `canCompact()` returned false every time, so
the switch never asked, and the `lastServedModel` reset was dead on arrival for the same reason.

Both objects are in scope at the registration, so the signature became structural and passes the
session too:

```js
/let ([\w$]+)=([\w$]+)\.modelSelection\.value,([\w$]+)=[\w$]+\(\2\.claudeConfig\.value\),([\w$]+)=[\w$]+\(\1,\2\.lastServedModel\.value,\3\);([\w$]+)\.commandRegistry\.registerAction\(\{id:"model",label:"Switch model…",description:"Change the AI model",trailingComponent:\4\?([\w$]+)\("span"/
```

The three reads in front are what pin the capture to the session rather than to whatever else the
minifier happens to call `t`, and the back-references keep all three on one object. One match in
2.1.227–2.1.241, always `session=t, ctx=n`.

Two halves of it stayed name-shaped for six releases, and 2.1.239 collected on both. The helper
calls were spelled `\w+`, and 2.1.239 renamed the `claudeConfig` one to `$b` — so the signature fell to
zero hits over a name it was not even capturing, the identifier-class trap the content-search points
below document at length. And the jsx factory went into the *replacement* as a bare `b`. That one has
never been renamed, but it is the worse of the two failure modes: a broken signature stops the
patcher with a hit count, while a stale `b` patches cleanly and throws a ReferenceError the moment
the composer renders. It is now captured off the `trailingComponent:` expression three literal
strings further into the same registration — `label:"Switch model…"`, `description:"Change the AI
model"`, then `trailingComponent:<label>?<jsx>("span"` — which is the most stable anchor available
without leaving the statement.

A DOM-level test cannot catch a mismatch here on its own — a fake context object carrying an
`activeSession` field passes while the real one has none, which is precisely how this got through the
first time. So the test also reads both sources and asserts that the patcher passes a third argument,
that it no longer writes the jsx factory in by name, that the hook accepts the session, and that the
page never reads the session off the context object.

### Content search reuses the session-list handoff — and needs `$` in its identifier class

Points #6–#9 sit in the same session-list component as #4, and exist for the same reason: the row
array and the title filter are local to that component, so anything wanting to widen the filter has
to be injected right where they already live, not called in from outside.

`\w` does not match `$`, and this component’s row parameter is `$e` — a plain `\w+` capture group
matches zero times here and nowhere else in the 4.7 MB bundle, which is a quiet way to fail: no
error, just a signature that happens to sit at hit-count 0 instead of 1 and gets caught by
`apply-patch.mjs`’s count check rather than by the regex itself. `[\w$]+` is what every capture group
in points #6–#9 uses instead.

Point #6 is the state declaration, anchored on the exact sequence the query state, the rename-target
state and the per-row ref map already form:

```js
,\[([\w$]+),([\w$]+)\]=([\w$]+)\(""\),\[([\w$]+),([\w$]+)\]=\3\(null\),([\w$]+)=([\w$]+)\(new Map\)
```

It inserts two more state pairs right after the query state — the ids the host reports back for
content search, and the pinned session ids — and hands both setters to `globalThis.__ccx` in the same
expression, the same trick point #4 uses for the registry and session.

Both hook aliases are captured rather than hardcoded, the same reasoning as everywhere else in this
file: they are locals among many, and the minifier renames them at will. This signature has been
broken twice by exactly that, once per alias, and each time the fix was to stop naming it:

| Release | `useState` | `useRef` | What broke |
|---|---|---|---|
| 2.1.233–2.1.234 | `ne` | `ge` | — |
| 2.1.235 | `ie` | `ge` | `useState` was hardcoded as `ne` |
| 2.1.238 | `ie` | `_e` | `useRef` was hardcoded as `ge` |

That is the general shape of these breaks: never every local at once, always some subset, and never
predictably which one — `useState` moved while `useRef` held, then the reverse. The failure is quiet
either way (hit count 0, not an exception), so `apply-patch.mjs`'s count check is what surfaces it.

Point #7 is the filter expression itself:

```js
([\w$]+)=([\w$]+)\?([\w$]+)\.filter\(\(([\w$]+)\)=>\{let ([\w$]+)=\2\.toLowerCase\(\);return ([\w$]+)\(\4\)\.toLowerCase\(\)\.includes\(\5\)\|\|\(\4\.gitBranch\.value\?\.toLowerCase\(\)\.includes\(\5\)\?\?!1\)\}\):\3
```

It ORs in a content match and — in the same expression, via the comma operator — assigns the
unfiltered row array to `globalThis.__ccxSearchCandidates`. That assignment is the only reason point
#9 does not need to capture the row array’s own name: it is a different statement, a good way down
the same component, and re-anchoring across that whole span for one variable would trade two small,
independent matches for one large, fragile one. Reading it off `globalThis` instead costs nothing —
the component re-runs the assignment on every render, so the global is never more than one render
stale, and the value is only ever read synchronously, inside the same render’s own event handlers.

Point #8 is the sort, which is its own signature since 2.1.257; it is described in the next section.

Point #9 is the search input’s `onChange`, anchored on the literal `placeholder:"Search sessions…"`
that follows it — the one piece of this trio that survives minification unchanged, because it is
user-facing text:

```js
onChange:\(([\w$]+)\)=>([\w$]+)\(\1\.target\.value\),placeholder:"Search sessions…"
```

It forwards every keystroke to `globalThis.__ccx.onSearchQuery` alongside the id list read off the
global above. `src/webview.js` owns everything from there: a 250 ms debounce, an immediate clear of
the previous result on every keystroke (so a slow answer to an abandoned query can never outlive the
query it answered), and a sequence number that drops any answer that is not for the newest request.
The host side greps each requested session’s raw `.jsonl` text case-insensitively rather than parsing
it — the query sits in the encoded message content either way, and parsing every line just to throw
the structure away would buy nothing — and caches the lowercased text per session on file mtime, so a
session unchanged since the last keystroke costs nothing to check again.

### Pinning is a sort, not a DOM move

The row a pin acts on is not the page's to keep. The session list is re-derived from the app's own
array on every render, and the array is ordered by recency — move the node and the next commit puts
it back. So pinning is point #8: a sort spliced into the same `let` chain the list is built in, run
before the component ever maps it to rows.

The sort is a stable partition into four blocks rather than a comparator: pinned ids, then the
sessions running a turn or waiting for input, then the ones open in a tab but idle, then the rest —
each block keeping the order it arrived in, so neither a pin nor a turn starting reorders anything
around it. The block a row lands in is its own status dot, read through the component's `openState`
accessor, which answers `"waiting"` / `"running"` / `"idle"` / `"unread"`, or nothing at all for a
session that is neither open nor holding unread output. Idle and closed are indistinguishable without
it — both have `busy === false` — which is the whole reason the signature reaches for it.

`"unread"` arrived in 2.1.257, and it is the one dot value that does not say whether the session is
open: the accessor returns it for an open idle session with unread output *and* for a closed one.
Both have something to show, which is what this sort orders by, so it ranks with the open-but-idle
block. Reading it as "unknown" instead would have sunk every open unread session to the bottom — the
exact opposite of the point — and nothing in the accessor's answer distinguishes the two cases.

Where the sort goes changed in 2.1.257, and the change is the interesting part. Through 2.1.252 the
app rendered the filter's own result, and the accessor was declared some 400 bytes further down the
same `let` chain — its name in a temporal dead zone at the filter, so the sort could not run there.
Point #7 therefore matched from the filter across that whole span, closed the chain with a `;`, ran
the sort as a plain assignment and reopened the chain with a fresh `let`.

2.1.257 ended that. A memo now sits between the filter and the render and partitions open sessions to
the front — `YA1(list, isOpen)`, `[...open, ...rest]`, stable within each half, the same array back
when either half is empty — and the grouping call takes *that* memo, not the filter's result. Sorting
the filter's result would be discarded a line later. So the sort moved onto the memo, which happens to
be declared immediately before the accessor:

```js
…,s4=C2(()=>{if(!w5)return d5;return YA1(d5,(K1)=>m5(K1)===!0)},[d5,w5,m5]),g2=H0(…),ccxPinSorted=(s4=globalThis.__ccx.pinSort(s4,ccxPinnedIds,g2)),[$4,l4]=…
```

Two adjacent declarations instead of a 700-byte span, appended to rather than rewritten, and #7 goes
back to being only about the filter. The stock partition is a coarser version of the same idea — open
first, everything else after, no pins and no running/idle distinction — so pinSort re-blocks its
output into all four ranks and the two compose rather than fight.

A list already in block order is returned as the same array, so a render that needs no move allocates
nothing, and an accessor that throws (or is missing, on an older patcher) drops the sort back to the
raw `busy`/`pendingInput` signals rather than failing.

That placement buys two things a DOM reorder cannot. The sorted array is what the component maps to
rows *and* what it derives its keyboard-navigation index from — a flattened `[...grouped, ...ungrouped]`
and a `Map` of row to position, both downstream of the memo the sort reassigns — so arrow keys walk the
list in the order that is actually on screen. And it composes with
search for free: the sort runs on whatever survived the filter, so an empty query puts the pins at the
very top and a query puts them at the top of the matches, with a pinned row that does not match simply
absent. A pin is a position, not an exemption.

The one thing the sort cannot do is re-render itself. Nothing in the component depends on the page's
copy of the pinned set, so a toggle would sit invisible until some unrelated state changed — which is
why point #6 declares a state pair for it and `onPinState` takes the setter. The page stays the owner:
`pinned.json` on the host is the record, `broadcast()` tells every tab, and `pushPinned()` writes a
fresh `Set` into the component's state, the new identity being the whole re-render signal. It is
skipped when membership is unchanged, so an ordinary state push does not re-render the list for
nothing. The click updates the page's own set first and sends to the host second — a pin that waited
for the round trip would read as a dropped click.

The control itself is the one decoration in the session list that could not be a pseudo-element:
`::before` on the row is already the provider mark, and neither can be clicked. It is a real `<span
role="button">` appended as the row's last child — past `sessionMeta`, so it lands at the right edge —
and the observer pass that draws the provider icons re-appends it if a commit ever moves it. React
reconciles the row's own children by position and never sees a trailing node that is not in its list.
The click handler reads the session id back off `dataset` rather than closing over it, because the
list re-keys and a DOM node can be reused for a different session.

Group headers are where this stops being exact. When the app is showing session groups it renders
`[...grouped, ...ungrouped]`, and the grouping runs *after* the sort — so a pin rises to the top of its
own section, not above the groups. Hoisting across that boundary would mean rebuilding the list's JSX
rather than reordering its input, which is a much larger and much more fragile patch for a case the
panel does not show until groups are created.

### Compacting before a switch rides on the stock `/compact`

The offer is a two-button toast; *Compact & switch* calls the page's own `session.send("/compact")` — the same thing the command menu's Compact entry does (`nn=()=>{i("/compact")}` in the composer). The CLI answers on the `io_message` stream with `{type:"system", subtype:"compact_boundary", compact_metadata:{trigger, pre_tokens}}`; the page already listens to that stream for `system/init`, so the boundary is the release for the restart. Two guards keep the switch from being held hostage: a boundary on another channel is ignored, and `COMPACT_WAIT_MS` (90 s) restarts uncompacted with a toast if none arrives. `send()` rejecting does the same at once. The offer itself is not asked when there is nothing to compact — no assistant turn yet, or a turn already running (`session.busy`) — and never on a fresh tab, which starts fresh with nothing to resume. `session.busy.value`, `session.messages.value` and `activeSession.value` are read off the app object the registry hook already hands over; none of them is patched.

### The usage-limit banner has a second tenant (2.1.247)

The auto-resume gesture tells a hard block from a soft notice by wording, because both render as
`[class*="banner_"][data-color="warning"]` — "You've hit your …" gets the prompt, "Approaching …"
and "You've used N% of …" do not. 2.1.247 adds a third possible text in that same slot.

The session class grew `usageLimitGrace`, a `null | "covered" | "finishing" | "stopped" | "dismissed"`
signal written by `setUsageLimitGrace(rateLimitInfo)` off the `rate_limit_event` stream. The render
reads it only through an experiment gate — `config.experimentGates.tengu_lantern_sconce===!0` — and
when it is set, its message takes precedence over the stock one:

```js
C0 = gate ? session.usageLimitGrace.value : null
r0 = C0 ? VA1(C0) : null          // "Usage limit reached · finishing up"
                                  // "Usage limit reached · a little extra on us, then your credits"
E2 = r0 ?? session.rateLimitWarning.value   // the stock "You've hit your …" only when r0 is null
```

Two things keep this from breaking anything. `VA1` returns `null` for `stopped` and `dismissed`, so the
moment the limit actually blocks, `E2` falls back to the stock text and the wording match works as it
always did. And `covered` renders `color:"normal"`, which the `[data-color="warning"]` selector does not
even see. So the grace window is silent for claudapter — correct, since nothing is halted while the
run is still allowed or still finishing.

Worth recording anyway: this is the first stock change since the gesture was written that puts new
text into the exact markup it reads, and the gate means it can switch on for an account without a new
extension version.

### `send()` has no hidden-message flag — retract hides via the DOM

`send(text, …)` (`async send(e,t,i,n,o)` on the session class) always builds a `{type:"user", uuid:crypto.randomUUID(), …}` turn, appends it to `messages.value` and pushes it to the CLI with `h.sendInput(u, l, !1)`. There is no `hidden`/`isMeta` option in that path — the bundle's own injected turns (`askDebuggerHelp()`, `enableJupyterMcp()`) are ordinary visible user messages, and `isMeta` does not appear in `webview/index.js` at all (it is a CLI-side transcript flag). So the retract gesture cannot ask the page to send an invisible turn; it sends the "ignore it" instruction through the ordinary `send()` and then hides its bubble — and the retracted exchange's bubbles — by a `data-ccx-hidden` attribute read off the same `messagePropOf` fiber walk the timestamps use.

The retract accounts for three turns, not one: the erroneous message and the assistant's answer (hidden immediately), the instruction turn, and the assistant's answer to *it* (an orphan reply to nothing, hidden too). The instruction's `uuid` is only knowable once `send()` has appended it, so the page tracks `pendingRetractBefore` (the `messages.value` index where the turn should land), resolves it the moment the turn appears — from the DOM observer and again from the `send()` promise's settle — and then hides the first `type:"assistant"` turn after it. The pending state is cleared by that resolution, *not* by `send()` resolving, which is what keeps the instruction from ever lingering visible: `send()` appends the turn to `messages.value` before its promise settles, so a `.then` that nulled the index would lose the race and leave the bubble showing forever.

A streaming turn is retracted too, but never mid-stream: `retractLastMessage` calls `session.interrupt()` (the same method the stop button and Escape use) and then polls `busy.value` — which clears when the CLI's `result` arrives — before running the retract proper. Polling is the ground truth rather than awaiting `interrupt()`'s promise, because the stop happens over the wire and only the `result` message finalises the partial response into `messages.value`. Sending the instruction any earlier would be a real bug, not just noise: the "first assistant message after the instruction" scan would match the still-settling old response instead of the instruction's own answer, so that answer could never be hidden. The poll is bounded (10 s) so a CLI that never answers leaves the turn alone with a toast instead of hanging.

The interruption itself then has to be skipped. When a turn is stopped, the CLI records it as an ordinary `type:"user"` turn whose text is `[Request interrupted by user]` (or `[Request interrupted by user for tool use]`) — with **no** `isSynthetic` flag, so the usual synthetic-turn guard does not catch it. Without an explicit check, `lastUserMessage` would take that marker as "the last message to take back": the instruction would quote the interruption, and the actual message (and its answer) would stay visible. `lastUserMessage` therefore skips any `type:"user"` turn whose text is exactly one of those two markers (`isInterruptTurn`), so the retract reaches past the interruption to the message the user really sent.

The retracted text also goes back into the composer for editing. `replaceComposerText` writes `textContent` directly — the same way the app's own `setInputText` does (`ne.current.textContent = ae; _(ae)`) — because `execCommand("insertText")` on a `contenteditable="plaintext-only"` box only lands when a live, collapsed selection is in place, and the select-all + delete that would clear the old draft leaves that selection invalid, so the text silently never appears. A direct write always lands, and a synthetic `input` event dispatched after it makes the app's `onInput` (`os`) read the text back and sync the draft signal (`v`), so the app's `se(()=>{ if(ne.current&&v==="") ne.current.textContent="" },[v])` effect does not wipe the fill.

Reading the text back out was the subtler half of the bug: `messages.value` entries are `Fp` objects whose `content` is an array of `Bp` wrappers, each holding the real block one level down — the text is `block.content.text`, not `block.text` (the bundle's own `LX` builds `new Bp({type:"text", text})`, and `Fp.isEmpty` reads `e.content`). `messageText` must therefore unwrap `b.content`; a flat `b.type`/`b.text` reads `undefined`, so `last.text` came back empty and the composer was never filled. The instruction wording is deliberately **not** localised like the attachment/resume prompts are — those are written into the visible composer and must read like the user's own prose, while the instruction is hidden machinery and the extension's UI is English, so `host.js` sends the same English sentence for every `/config` language. The hidden uuids are persisted in `~/.claude/claudapter/hidden-messages.json` so a resume re-hides them, and the host's content search parses the `.jsonl` per line (only for sessions that have retracted something) so a retracted message stops matching.

### The stock model indicator names the last provider that answered

`Switch model… → <model>` in the command menu is the extension's own `modelIndicator`, fed by `session.lastServedModel`. That signal is written in `processMessage` from `e.message.model` on every assistant turn — and `loadFromMessages` runs `processMessage` over the whole transcript while seeding a resume, before the CLI has said a word. So after a provider switch the menu says, truthfully but misleadingly, which model the *old* provider answered with, until the new one answers. The stock reset is in the `system/init` branch and fires only when `session_id` changes, which a `--resume` never does. `performRestart` therefore clears `lastServedModel.value` on every switch, so the menu falls back to the selection.

### A foreign `previous_message_id` closes the way back to Anthropic (2.1.247)

Every request the CLI builds can carry one diagnostic field:

```js
...Ie && p && Se && !S_ ? { diagnostics: { previous_message_id: u ?? null } } : {}
```

`u` is the id of the answer before this one, read back off the transcript (`message.id`), and the field is its prompt-cache-break diagnosis — the same machinery behind `tengu_prompt_cache_diagnosis_received` and the `[PROMPT CACHE BREAK]` warning. The conditions restrict it to Anthropic, which is exactly why it never shows up while a tab is running on someone else's backend: it is the *return* that breaks.

An id from another provider does not have Anthropic's shape. OpenRouter answers with `gen-1787815743-Wd0oDf0iH9SHXerqJ6DS`, and sending that back gets

```
400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)
```

Nothing recovers from it. The CLI knows the failure by name but only to label it:

```js
if (e instanceof xn && e.status === 400 && e.message.includes("diagnostics.previous_message_id"))
    return "previous_message_id_invalid";
```

— a telemetry classification, not a retry. And since `u` is read from the `.jsonl`, relaunching the channel reproduces it: the session answers `400` to every turn from Anthropic, forever, while the same session on the old provider still works. In the run that turned this up (openrouter → claude) two turns died this way three minutes apart, one of them after a full process restart, and the tab had to be abandoned.

`envFor` therefore strips the offending ids from the transcript before the spawn (`stripForeignMessageIds`), and only when that spawn is the one going to Anthropic (`targetsAnthropic`: the profile's own `ANTHROPIC_BASE_URL` when it brings routing of its own, otherwise `settings.json` then the ambient environment — the CLI's own layering). `previous_message_id: u ?? null` accepts null, so deleting `message.id` is the whole repair; an id that already starts with `msg_` is left in place, and so is every line that is not an assistant turn — including a half-written trailing one, which is why each line is parsed on its own and written back verbatim unless it is the one being fixed.

This is the only place claudapter writes into a file the CLI owns. It rewrites in place rather than through a temp file and a rename, because on Windows a rename over a path the CLI still holds open fails outright, and it runs in the gap between the old process going away and the new one starting. The content-search and timestamp caches key on mtime+size, so both are dropped for that session afterwards.

### Menu ordering

The command registry (`class AX` in `webview/index.js`) sorts each section by a hard-coded id list; unknown ids fall to the end:

```js
if (t === "Model") {
    let r = ["model", "effort-level", "toggle-thinking", "switch-models-on-flag", "account-usage"];
    n.sort((s, a) => { /* indexOf, missing ones → r.length */ });
}
```

So the position of a custom entry is set by adding its id to that array, not by registration order.

### The session history carries no session id

The history row (`webview/index.js`, minified `ELt`, anchor `` className:`${bn.sessionItem}` ``) is a bare
`<button>` whose entire prop object is `{ref, className, onClick, onMouseMove, children}` — no `id`, no
`data-*`, no `title`, no `aria-label`. The session id exists only as the React key at the call site,
`Ue.sessionId.value ?? et`, and React never serialises keys to the DOM. `data-session-id` and
`data-session` have zero occurrences in the whole 4.6 MB bundle.

React writes `__reactFiber$<random>` onto every host node it creates, but that pointer is set at mount
(`createInstance`) and never refreshed — `commitWork` updates only `__reactProps$`. With double buffering,
`el[__reactFiber$…]` is therefore the *stale alternate* on roughly every other commit, so `memoizedProps`
cannot be trusted for scalar props. `createWorkInProgress` does copy `key` onto the alternate, which makes
`fiber.key` the one stale-proof read — and it is exactly the session id.

A non-UUID key is the array-index fallback: the session had no id when it rendered. Those rows are refused
outright, which also removes the only case that could yield a *wrong* session — two index-keyed rows
swapping positions and rebinding a reused fiber pair.

That refusal is what makes the *other* fallback safe. A row whose id resolves but carries no entry in
`bindings.json` ran on whatever `settings.json` said at the time, so it takes the mark of the profile that
matches `settings.json` now — the stock Claude logo on an untouched install. The host computes that once
(`fallbackIcon`) and withholds it entirely when `settings.json` names a base URL no profile describes,
because then the answer is genuinely unknown. The distinction that matters: an id that resolved but has no
binding is a session we can reason about, while an id that did not resolve is a row we cannot attach
anything to without risking the wrong session.

The icon is painted as a `::before` pseudo-element with `background-image:var(--ccx-icon)` rather than an
injected `<img>` child: React reconciles host children by index, and `className` is rewritten on every
`isActive`/`isFocused` change, so a class or a child node of ours would be wiped. `data-*` attributes and
inline `style` are not React-managed on that button and survive. The row is
`display:flex;align-items:center;gap:8px`, so the pseudo-element simply becomes its leading flex item.

The list is reachable at all because `resolveSessionListView` builds the sidebar view through the *same*
`getHtmlForWebview` as the chat panel — the injected script is already present in both surfaces, so this
needed no sixth injection point.

### Message timestamps read the same stale-prone fiber, on purpose

Each transcript bubble (`data-testid="assistant-message"`, or the `userMessageContainer_` div) is rendered
from a `message` prop — `{type, uuid, content, timestamp, …}`, the same shape as the `.jsonl` line it came
from — and that field is nowhere else: not in the DOM, not in `ccx:state`. `messagePropOf` reads it off
`fiber.memoizedProps.message`, walking up to four `.return` hops the same way `sessionIdOfRow` walks up for
`.session` — the div's own host fiber carries only its own DOM props, the component fiber one level up is
the one that actually received `message` in JSX.

That is the same `memoizedProps` read the section above calls untrustworthy for scalar props, and it is used
here anyway, deliberately: the risk it describes is a fiber slot being *reused for a different logical row*
— list virtualization or reordering handing the same DOM node to a different session between commits, which
is a real hazard in a picker that groups and re-sorts. The transcript has neither: messages are appended,
never reordered or virtualized away, so a bubble's fiber stays bound to the same message for its entire
life. And the one field read here, `timestamp`, is written once when the message is created and never
mutated afterward — unlike `content`, which keeps changing while a turn streams — so even catching a stale
alternate mid-render returns the same value a fresh read would. `sessionIdOfRow` additionally cross-checks
`fiber.key` because a wrong session id there means a wrong *provider* icon; a timestamp one paint behind,
self-correcting on the next debounced pass 60 ms later, does not carry that cost.

Written as `data-ccx-time` / `data-ccx-date` plus a `::after` / `::before` pseudo-element, not an injected
child — the same reasoning as the provider mark: an assistant bubble keeps re-rendering while its turn is
still streaming, and a real child node risks being wiped on the next commit where a data attribute on the
node React already owns does not.

The time went through two flex-based attempts before landing on `position:absolute` instead, and both
detours are worth recording — the same shape of mistake is easy to repeat the next time something needs
pinning to a corner of a flex item.

`.message_07S1Yg{display:flex;flex-direction:column;align-items:flex-start;position:relative;…}` is the
actual box, verified from `webview/index.css`, not assumed from the session-list icon's row-flex
precedent. First attempt: `flex-basis` on the `::after`, meant to force full width — wrong axis, since a
column flex's main axis is vertical, so `flex-basis` claims *height*. Second attempt: `align-self:
stretch`, the axis-correct way to span a column flex's cross axis — right in theory, and it still did not
visibly fix the reported bug, because the actual complaint was never about width in the first place: it
was several unrelated bubbles' trailing labels reading as one confusing cluster, which no amount of
correcting one bubble's own alignment was going to touch.

`position:absolute` sidesteps the question entirely: `.message_` already has `position:relative` (no
setup needed), and an absolutely positioned element ignores `flex-direction` and `align-items` completely
— `right:8px;bottom:2px` pins it to the bubble's own corner regardless of what layout mode the container
is in, or ever changes to. `pointer-events:none` keeps it from stealing clicks meant for text it may sit
over; `white-space:nowrap` is unchanged from the flex attempts and still does the same job — a narrow
sidebar otherwise wraps `"4:31 PM"` between the number and the meridiem, reading as two lines instead of
one label.

That corner placement is also what makes showing a time on *every* bubble viable. A first pass tried
collapsing a run of same-speaker bubbles — a thinking summary, one per tool call, the text answer — down
to a single trailing time, reasoning that a full-width line repeated three or four times in a row reads as
noise. Feedback was the opposite: readers wanted the time on every message, not fewer of them. With the
label corner-anchored rather than taking its own line, that preference costs nothing to grant — nothing
was collapsing lines any more, so there was nothing left for the grouping to save.

The date `::before` has a problem the time `::after` never did: `.timelineMessage_07S1Yg:before` — the
assistant bubble's own class — already owns that pseudo-element slot, drawing the small
success/failure/progress status dot. Same specificity as `[data-ccx-date]::before` (one class vs one
attribute selector), so which one wins is otherwise decided by stylesheet order — not something worth
depending on. `!important` makes it deterministic: the date pill always wins the one message a day where
they would collide, and that message's status dot goes undrawn. A once-a-day cosmetic gap, chosen over a
pill that might silently never show on assistant messages depending on injection order. It stays a
block-level pill centered with `margin:auto`, not corner-anchored — a day boundary is a fact about the
gap between two messages, not a property of one bubble's corner.

"Today" / "Yesterday" come from `Intl.RelativeTimeFormat`, not a hand-written table: every language the CLI
already speaks through `/config` is one `Intl` already speaks too, so this needed no entry in `LANGUAGES` —
it reads the runtime's own locale rather than the CLI's configured one, which is the more chat-app-like
choice here (Telegram does the same) and, unlike the attachment prompt, does not need to agree with what
language the *model* answers in.

### A subagent's turns reach the page in two shapes, and neither is drawn

Everything a `Task` subagent says arrives on the same `io_message` stream as the rest of the tab, and the
page keeps all of it. `N8` (the SDK-envelope → message converter) copies `parent_tool_use_id` onto every
turn it builds, under two names with slightly different rules:

```js
let t = e.type === "user" ? e.parent_tool_use_id : null,
    i = e.parent_tool_use_id ?? null;
… new Up(e.type, …, { parentToolUseId: t, sdkParentToolUseId: i })
```

So a **user** turn carries the id under both names, an **assistant** turn rebuilt from an envelope only
under `sdkParentToolUseId` — while an assistant turn assembled from a live stream gets it under
`parentToolUseId`, because the assembler creates it that way (`new Up("assistant", [], {parentToolUseId: o})`,
and `processStreamEvent(e.event, e.parent_tool_use_id)` is what partitions the stream by parent in the
first place). Reading both is not belt-and-braces; each name alone misses a case.

They are then filtered out at render: `_be` returns `null` for a user message with a `parentToolUseId`, and
the assistant ones are folded into a `focus-fold` row keyed off `subagentSpans` — a tool count and nothing
else.

**But that path is not the one the `Agent` tool takes.** Measured on 2.1.241: an `Agent` call — foreground
and background alike — runs as a *task* (`task_type: "local_agent"`), and its turns never reach the page.
They go to the task's own `.output` file, and the parent transcript gets no `isSidechain` lines at all
(checked on a session with two `Agent` calls: `"isSidechain":true` count zero, `"name":"Task"` count zero —
the tool is called `Agent`, not `Task`, in this release). `CLAUDE_CODE_ENABLE_TASKS="0"` in `Qh()` does not
prevent this.

What the page gets for a task instead is `subagentTasks`, a signal fed by
`system/task_started|task_progress|task_notification`:

```js
{ taskId, toolUseId, description, prompt, taskType, startTime, status,
  usage: {totalTokens, toolUses, durationMs}, summary, recentTools /* last 3 */ }
```

`toolUseId` is the `Agent` call's own `tool_use` id, so it keys straight onto the block in the transcript.
Nothing in the render layer reads any of it — all eighteen references sit in the session model and in one
telemetry field (`subagent_count`) — and `handleTaskNotification` **deletes** the entry as soon as the task
ends, so anything that wants to show a final state has to keep its own copy.

The practical consequence for a patcher: a live view of a subagent needs **no new plumbing**, but it does
need both sources — the message walk for an inline subagent, `subagentTasks` for a task-shaped one, and the
former is the one to prefer where it has anything, since a summary is never as good as the turns. The
property names survive minification the same way `message.timestamp` does — bun's minifier renames locals,
not properties.

What it cannot do is show an old run. `B5t`, the transcript → SDK-message converter, drops sidechain lines
outright (`if (e.isSidechain) return !1`), so a session replayed from disk comes back without any of its
subagents' turns. Watching a run is live-only unless the `.jsonl` is read separately.

### CSP and loading your own script

`getHtmlForWebview` (line 140039) emits `script-src 'nonce-…'` (line 140070), and `localResourceRoots` is limited to the `webview/` and `resources/` directories inside the extension. An external file cannot be referenced by URI — hence the custom code is inlined into the HTML with their nonce, while the text itself is read from disk when the page is generated (so edits apply without re-patching).

Injection point #1 sits on that `<script … type="module">` tag, and until 2.1.245 it was a plain literal
naming three locals outright: `<script nonce="${u}" src="${a}" type="module"></script>`. 2.1.245 renamed
all three — the nonce `u` → `U`, the bundle's own script URI `a` → `G`, and the webview parameter `e` → `$`,
which is the one the injected call is handed. So the anchor now starts at `getHtmlForWebview` — the only
unminified name in reach — and runs to that tag through a lazy gap. The parameter and the nonce come out
of the match, and the whole span is re-emitted with the host's `<script>` in front of the tag. There are
four `getHtmlForWebview(` occurrences in the bundle, but only the definition is followed by `{`, so the
count check still sees exactly one match.

Execution order: their inline flag script → our classic script → their bundle (`type="module"`, deferred). That lets our code call `acquireVsCodeApi()` first and replace the global with a proxy that sees every outgoing message. Unknown types are ignored by the UI — its listener only reacts to `type === "from-extension"`.

The same tag emits `img-src ${e.cspSource} data:`, and that `data:` is the only reason profile icons can be
inlined as base64 at all: `localResourceRoots` covers just `webview/` and `resources/` inside the extension,
so `~/.claude/profiles` can never be referenced by URI. `style-src` carries `'unsafe-inline'`, which is what
lets the injected `<style>` block work without a nonce. `font-src` has **no** `data:`, so an icon-font
strategy is not available. Note also that an SVG loaded through `<img src="data:…">` is an isolated
document: it does not inherit `currentColor` or any VS Code theme variable, and in percent-encoded form a
literal `#` truncates the URL. Brand marks are unaffected — they carry their own colours — but a
theme-coloured glyph would have to be an inline `<svg>` element instead.

### A dropped extension folder is never loaded

Not a bundle finding but a VS Code one, and it decides how the keeper (the companion extension that
re-applies the patch after a Claude Code update) is installed. `~/.vscode/extensions` looks like a
directory VS Code scans, and putting a folder with a valid `package.json` in it looks like it works. It
does not: since 1.74 the scan is cached in `~/.vscode/extensions/extensions.json`, and a folder that was
never installed through the CLI stays out of that cache and is simply never activated. On this machine
`local.claude-profiler-0.0.1` had been sitting there for months — its `extension.js` present, its
`package.json` valid, absent from `extensions.json` and from `code --list-extensions`, dead the whole
time. There is no error and no entry in the Extensions view; the extension is just not there.

`code --install-extension <file>.vsix` is the only way in that also registers the extension, and it
takes a `.vsix` — never a folder. That is a ZIP with `extension/` beside an `extension.vsixmanifest`
and a `[Content_Types].xml`, which is 60 lines of `deflateRawSync` and the CRC-32 already used for PNG
output (`scripts/vsix.mjs`); `vsce` would pull a dependency tree into a project that has none. Two
Windows details cost a run each: `where code` answers with the extensionless bash script *before* the
`.cmd`, and Windows cannot execute the first one at all; and a `.cmd` cannot be spawned directly since
the Node 18.20/20.12 security fix, so it goes through a shell — handed the whole command line rather
than an args array, which is also what keeps `DEP0190` out of the installer's output.

## Non-Anthropic providers

The CLI has no OpenAI support: across the whole 24 MB bundle there is neither `chat/completions` nor `OPENAI_API_KEY`; the nine occurrences of `openai` are secret-scanner regexes and skill texts. Only the Anthropic API, Bedrock (`CLAUDE_CODE_USE_BEDROCK`) and Vertex (`CLAUDE_CODE_USE_VERTEX`) are supported — all on top of the Messages API.

The API surface an adapter actually has to cover (by occurrence count in the bundle):

| Surface | Occurrences | Note |
|---|---:|---|
| `v1/messages` | 64 | the main endpoint, SSE |
| `tool_use` | 1226 | without tools the CLI is useless |
| `cache_control` | 85 | strip it: OpenAI caching is implicit |
| `/v1/messages/count_tokens` | 14 | needed for the context indicator |
| `thinking_delta` | 15 | not reproducible across the bridge |

`cache_control` is dropped rather than translated because caching on these backends is implicit, keyed on the prompt prefix — but a hit still has to be *reported*. It arrives folded into the input count (`usage.input_tokens_details.cached_tokens`, or `prompt_tokens_details.cached_tokens` on the chat protocol), while the Messages API counts cached tokens beside the input and every reader downstream sums the two: the CLI's context meter, the delegated-run report, a profile's own `pricing` block. The adapter subtracts the cached part and returns it as `cache_read_input_tokens`, so a hit shows as a hit instead of as input charged a second time at the uncached rate. `cache_creation_input_tokens` is always zero — an implicit cache never bills the write.

*Which* cache a turn lands in is not implicit, though. Every Responses request carries `prompt_cache_key`: the same conversation id the codex backend gets in its `session_id` header, derived from the opening messages, so the turns of one session keep landing on the prefix that session itself wrote. An upstream that rejects the field is opted out with `"promptCacheKey": false` in its `proxy.json` entry.

Measured against the live codex backend, with `claude -p` on `gpt-5.6-luna` and a 17,933-token request:

| runs | `input` | `cache read` |
|---|---:|---:|
| first ever | 17,933 | 0 |
| second, same opening question | 1,037 | 16,896 |
| second, different opening question | 17,933 | 0 |

So the cache is real and it is worth 94% of the request — but that backend groups it by `session_id`, and a different opening question is a different session. Keying `prompt_cache_key` on the prefix instead of the conversation was tried and changed nothing there, which is why it follows the conversation id. The practical consequence is [in the README](../README.md#what-a-run-cost): a delegated run continued through its `session` reuses the prefix, a fresh `run_agent` pays for it again.

### The ChatGPT subscription protocol

Reverse-engineered from the open source of [claudex](https://github.com/pilc80/claudex) (Rust):

- OAuth PKCE: `client_id = app_EMoamEEZ73f0CkXaXp7hrann`, issuer `https://auth.openai.com`, token endpoint `/oauth/token`, scope `openid profile email offline_access`, `code_challenge_method=S256`, `id_token_add_organizations=true`
- the callback must be exactly `http://localhost:1455/auth/callback`
- backend `https://chatgpt.com/backend-api/codex/responses`, headers `Authorization: Bearer` and `chatgpt-account-id`
- `account_id` is extracted from the `id_token` (claim `https://api.openai.com/auth`)
- existing Codex CLI tokens live in `~/.codex/auth.json` (`tokens.access_token` / `refresh_token` / `account_id`)
- the backend accepts only its own `instructions` and always streams, so the system prompt has to travel as the first `input` message
- `session_id` is what ties a request to a conversation; a fresh uuid per request tells the backend every turn is a new one and invalidates any replayed `reasoning` item, so it is derived from the opening messages instead

### Why the agent used to stop mid-task

Three separate things ended a turn early, all of them invisible in the transcript — no error, a well-formed `end_turn`, and an agent that quietly gave up:

| Cause | What it looked like | Fix |
|---|---|---|
| the harness prompt sits at input position 1 as a user turn, thirty items behind the live one | the model answers conversationally, announcing a step instead of taking it | a restatement of the agent rules appended after the last turn, when the request carries tools |
| reasoning items never come back (`store: false`, nothing to carry them through the CLI's history) | the model re-derives its intent from its own prose each request and drops work it had committed to | `include: ["reasoning.encrypted_content"]` plus a proxy-side store keyed by `call_id`, replayed ahead of the items it produced |
| an SSE that ends without `response.completed` | `finish()` closed it as a normal answer: `stop_reason: end_turn`, no retry | a stream without a terminal event is reported as an error |

The first two are prompt-shaped and degrade gracefully; the third is a protocol bug and was the one that could stop an agent with no trace at all.

### Full authorize parameter set

```
response_type=code
client_id=app_EMoamEEZ73f0CkXaXp7hrann
redirect_uri=http://localhost:1455/auth/callback
scope=openid profile email offline_access
code_challenge=<PKCE S256>
code_challenge_method=S256
id_token_add_organizations=true
codex_cli_simplified_flow=true
originator=<client identifier>
state=<random>
```

The official Codex CLI additionally requests `api.connectors.read api.connectors.invoke` and supports `allowed_workspace_id`. The short scope is enough.

### OAuth and networking traps (each one cost a separate investigation)

**`cmd /c start` splits the URL on `&`.** The classic way to open a browser on Windows breaks any OAuth URL: only the first parameter reaches the browser and OpenAI answers `missing_required_parameter`. Measured against a local server:

| method | parameters delivered |
|---|---|
| `cmd /c start "" <url>` | **1** (`tag`) |
| `cmd /c start "" "<url>"` | request never arrived |
| `rundll32 url.dll,FileProtocolHandler <url>` | **6** — all of them |

A diagnostic trap: the error looks like a missing-parameter problem, which tempts you to "fix" it by adding fields that were already there.

**Node does not read `HTTP_PROXY`.** It needs the `--use-env-proxy` flag (Node 24+). Without it, from a geo-blocked region every OpenAI request returns `403 unsupported_country_region_territory`; with it the same request answers on the merits (`400 Missing parameter 'redirect_uri'`). The flag is required both for the login flow and for the adapter — including the instance the extension spawns.

**`NO_PROXY` for the local upstream.** The `claude` process inherits the proxy variables and tries to reach `127.0.0.1:8787` through the corporate proxy. Measured: `fetch('http://127.0.0.1:8787/health')` with `HTTP_PROXY` set → `fetch failed`; with `NO_PROXY=127.0.0.1,localhost` → `200`. In the CLI log this shows up as `API error (attempt N/11): undefined Connection error`.

**403 HTML instead of JSON** from `chatgpt.com` means the request bypassed the proxy (Cloudflare/geo), not that the body was malformed. Verified: 0, 5 and 30 tools, with and without `User-Agent: codex_cli_rs` and `openai-beta` — every combination returns `200` once the route is correct.

**`process.exit()` with active handles** crashes Node on Windows with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`. Use `process.exitCode` instead.

**A streaming backend does not make every answer a stream.** The codex backend only streams, so the adapter always sends `stream: true` upstream — but the caller's own `stream` flag decides what goes back. Answering `stream: false` with `text/event-stream` is not a protocol error the SDK reports: it sees a non-JSON content type, hands the raw body back as a **string**, and the failure surfaces far away as `TypeError: undefined is not an object (evaluating 'z.usage.input_tokens')`. What breaks is the auto-mode permission classifier, which asks this way — it fails closed, so every `Edit` is denied with "retry guidance" while the main streamed conversation keeps working. Symptom to recognise: the model starts explaining that the environment is temporarily unable to modify files, and `proxy.log` shows no error at all.

### Responses API vs Chat Completions

| | Chat Completions | Responses |
|---|---|---|
| history | `messages[]` | `input[]` with `message` / `function_call` / `function_call_output` items |
| assistant text | `content` | `content: [{type:"output_text"}]` |
| tools | `{type:"function", function:{name,...}}` | flat: `{type:"function", name, parameters}` |
| tool result | `role:"tool"` + `tool_call_id` | `function_call_output` + `call_id` |
| streaming | anonymous chunks with `delta` | named `response.*` events |
| tool arguments | `tool_calls[].function.arguments` deltas | `response.function_call_arguments.delta` |

Both formats collapse into the same Anthropic events: `message_start` → `content_block_start/delta/stop` (`text_delta`, `input_json_delta`) → `message_delta` (`stop_reason`, usage) → `message_stop`.

## Native binary

`claude.exe` is a bun standalone executable (319,026,336 bytes): `/$bunfs/root/` and `B:/~BUN/root/` markers, the `---- Bun! ----` trailer at offset 319,015,421, followed by ~10 KB of Authenticode signature. The CLI's JS bundle sits there **in the clear**: a contiguous UTF-8 region at `283,720,669..310,250,408` (25.30 MB) starting with `// @bun @bytecode @bun-cjs (function(exports, require, module, …)`. Two much smaller bundles of the same shape follow it at `310,250,441` and `310,252,643` — the loaders for `image-processor.node` and `audio-capture.node`.

Offsets move on every release; locating the region by scanning forward from the `// @bun @bytecode @bun-cjs` marker while the bytes stay valid UTF-8 text is what actually survives an update.

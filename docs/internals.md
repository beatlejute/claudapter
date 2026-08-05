# Inside Claude Code for VS Code

A teardown of version **2.1.222** (`anthropic.claude-code-2.1.222-win32-x64`). Everything below comes from the bundle itself: line numbers refer to a formatted `extension.js` (`prettier 3.x --parser babel`, 129,300 lines), signatures to the minified original. Minified identifiers are renamed on nearly every release — they are quoted to make a spot findable, not as stable names.

## Package contents

| File | Size | What it is |
|---|---:|---|
| `resources/native-binary/claude.exe` | 266 MB | the CLI itself — bun standalone + Authenticode |
| `webview/index.js` | 4.6 MB | UI: React 18.3.1, marked, parts of monaco |
| `extension.js` | 2.5 MB | the extension host (bun bundle) |
| `webview/index.css` | 371 KB | UI styles |
| `resources/audio-capture/*/audio-capture.node` | 498 KB | native module for dictation |

## Two activation paths

`activate()` (`b9t`, line 128888) brings up two independent things:

1. **Native UI** — the webview/session manager (class `PG`, line 125537): providers `claudeVSCodeSidebar`, `…SidebarSecondary`, `claudeVSCodeSessionsList`, the `claudeVSCodePanel` panel, 23 contributed commands, a status bar item, and the `_claude_vscode_fs_left/right/readonly` FS providers used for diffs.
2. **IDE MCP server** (tool registration `eCe`, line 128519; listener `tCe`, line 128797 — lines 128519–128831) — what a terminal-launched CLI talks to: HTTP+WebSocket on `127.0.0.1`, authorization via the `x-claude-code-ide-authorization` header (a random UUID), a lock file and the `CLAUDE_CODE_SSE_PORT` handoff.

MCP server tools: `openDiff`, `getDiagnostics`, `close_tab`, `closeAllDiffTabs`, `openFile`, `getOpenEditors`, `getWorkspaceFolders`, `getCurrentSelection`, `getLatestSelection`, `checkDocumentDirty`, `saveDocument`, `executeCode` (Jupyter). Notifications: `diagnostics_changed`, `log_event`.

## How Claude is launched

The extension embeds **Claude Agent SDK 0.3.222** (the same version published on npm as `@anthropic-ai/claude-agent-sdk`) and calls `query()` with a transport pointing at `claude.exe`:

```
--output-format stream-json --verbose --input-format stream-json
```

`spawnClaude` (line 124124, in class `yo` at line 123883) assembles the options:

- `systemPrompt: { type: "preset", preset: "claude_code", append: … }`
- `settingSources: ["user", "project", "local"]`
- `enableFileCheckpointing: true`
- hooks: `PreToolUse` — `Edit|Write|MultiEdit` (baseline snapshot) and `Edit|Write|Read` (autosave); `PostToolUse` — diagnostics collection
- `extraArgs: { debug, debug-to-stderr, enable-auth-status, no-chrome, replay-user-messages }`
- env: `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, `MCP_CONNECTION_NONBLOCKING=true`, `CLAUDE_CODE_ENABLE_TASKS=0`

The environment comes from `Up()` (line 125473): `process.env` plus the `claudeCode.environmentVariables` setting. **It is frozen at spawn time** — a provider cannot be swapped inside a live process, the channel has to restart.

The assignment, minified, is injection point #3 (line 124199 formatted):

```js
if(f.pathToClaudeCodeExecutable=m,f.executableArgs=h,f.env=x,_)f.executable=_;
```

Every identifier there is a minified local, and the minifier reshuffles them release to release (2.1.220 had `f.env=w,g)`, 2.1.221 and 2.1.222 have `f.env=x,_)`). A literal signature therefore breaks on almost every update; matching the shape instead survives it:

```js
/(\w+)\.pathToClaudeCodeExecutable=(\w+),\1\.executableArgs=(\w+),\1\.env=(\w+),(\w+)\)/
```

The back-reference pins all three assignments to the same options object, and the resume session id is read back off that object (`resume:t` in the literal) rather than from the `spawnClaude` parameter, which is renamed just as often.

## The webview ↔ host protocol

Request/response with a `channelId`; dispatch lives in `processRequest` on the base class `gq` (line 113273) with roughly 90 message types, and the session class `yo` overrides it (line 124052) for the handful it handles itself. The host sends `{type:"from-extension", message}` to the UI; the process stream arrives as `{type:"io_message", channelId, message, done}`.

Messages from the webview that matter to a patcher:

| Message | Carries | Used for |
|---|---|---|
| `launch_claude` | `channelId, cwd, resume, permissionMode, thinkingLevel` | intercepted right before the spawn to inject the profile |
| `close_channel` | `channelId` | clean process shutdown before a restart |
| `request.update_session_state` | `sessionId, state, title` | **the reliable source of `sessionId`** |
| `request.rename_tab` | `title, hasPendingPermissions, hasUnseenCompletion` | overwrites the tab title and icon |

`system/init` in the CLI stream also contains `session_id`, but catching it by intercepting `webview.postMessage` proved unreliable — `update_session_state` is the one that works.

## Traps found while patching

### `rename_tab` overwrites the icon

The handler (line 124077) **unconditionally** rewrites both title and icon:

```js
this.panelTab.title = e.request.title;
let r;
if (e.request.hasPendingPermissions) r = "claude-logo-pending.svg";
else if (e.request.hasUnseenCompletion) r = "claude-logo-done.svg";
else r = "claude-logo.svg";
this.panelTab.iconPath = ge.Uri.file(On.join(this.context.extensionPath, "resources", r));
```

It fires on every title change, so an icon set once gets wiped. The fix is to intercept the `iconPath` setter on the panel object and only substitute `claude-logo.svg`, letting pending/done through.

### An existing session's panel cannot be reopened

`createPanel` (line 125790):

```js
createPanel(e, t, r) {
    if (e) {                              // e = sessionId
        let a = this.sessionPanels.get(e);
        if (a) {
            if ((a.reveal(), t))          // t = a prompt to seed — silently dropped
                Tt.window.showInformationMessage(
                    "Session is already open. Your prompt was not applied — enter it manually.",
                );
            return { startedInNewColumn: !1 };   // does NOT create a new panel
        }
    }
```

So `claude-vscode.editor.open` with a live `sessionId` only reveals the existing panel, and any prompt handed to it is dropped with a notice. The panel's `onDidDispose` (line 125910) does drop the entry from `sessionPanels`, so a *closed* session reopens cleanly — but there is no path that gives you a second panel on a session that is still open. The working approach for a provider switch is to restart the channel, not the panel.

### Channel shutdown is asynchronous

`close_channel` does not complete instantly: roughly 0.5 s pass between "Closing Claude on channel" and the channel actually being freed. Sending `launch_claude` on a timer before that returns `Channel already exists`, after which the host finishes killing the channel and the tab is left without a process (`Channel not found for io_message`). The trigger must be the **incoming** `close_channel`, not a timeout.

### Menu ordering

The command registry (`class UG` in `webview/index.js`) sorts each section by a hard-coded id list; unknown ids fall to the end:

```js
if (t === "Model") {
    let r = ["model", "effort-level", "toggle-thinking", "switch-models-on-flag", "account-usage"];
    n.sort((s, a) => { /* indexOf, missing ones → r.length */ });
}
```

So the position of a custom entry is set by adding its id to that array, not by registration order.

### CSP and loading your own script

`getHtmlForWebview` (line 126008) emits `script-src 'nonce-…'` (line 126039), and `localResourceRoots` is limited to the `webview/` and `resources/` directories inside the extension. An external file cannot be referenced by URI — hence the custom code is inlined into the HTML with their nonce, while the text itself is read from disk when the page is generated (so edits apply without re-patching).

Execution order: their inline flag script → our classic script → their bundle (`type="module"`, deferred). That lets our code call `acquireVsCodeApi()` first and replace the global with a proxy that sees every outgoing message. Unknown types are ignored by the UI — its listener only reacts to `type === "from-extension"`.

## Non-Anthropic providers

The CLI has no OpenAI support: across the whole 22 MB bundle there is neither `chat/completions` nor `OPENAI_API_KEY`; the nine occurrences of `openai` are secret-scanner regexes and skill texts. Only the Anthropic API, Bedrock (`CLAUDE_CODE_USE_BEDROCK`) and Vertex (`CLAUDE_CODE_USE_VERTEX`) are supported — all on top of the Messages API.

The API surface an adapter actually has to cover (by occurrence count in the bundle):

| Surface | Occurrences | Note |
|---|---:|---|
| `v1/messages` | 54 | the main endpoint, SSE |
| `tool_use` | 1151 | without tools the CLI is useless |
| `cache_control` | 80 | strip it: OpenAI caching is implicit |
| `/v1/messages/count_tokens` | 12 | needed for the context indicator |
| `thinking_delta` | 11 | not reproducible across the bridge |

### The ChatGPT subscription protocol

Reverse-engineered from the open source of [claudex](https://github.com/pilc80/claudex) (Rust):

- OAuth PKCE: `client_id = app_EMoamEEZ73f0CkXaXp7hrann`, issuer `https://auth.openai.com`, token endpoint `/oauth/token`, scope `openid profile email offline_access`, `code_challenge_method=S256`, `id_token_add_organizations=true`
- the callback must be exactly `http://localhost:1455/auth/callback`
- backend `https://chatgpt.com/backend-api/codex/responses`, headers `Authorization: Bearer` and `chatgpt-account-id`
- `account_id` is extracted from the `id_token` (claim `https://api.openai.com/auth`)
- existing Codex CLI tokens live in `~/.codex/auth.json` (`tokens.access_token` / `refresh_token` / `account_id`)
- the backend accepts only its own `instructions` and always streams, so the system prompt has to travel as the first `input` message

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

`claude.exe` is a bun standalone executable (279,014,048 bytes): `/$bunfs/root/` and `B:/~BUN/root/` markers, the `---- Bun! ----` trailer at offset 279,003,325, followed by ~10 KB of Authenticode signature. The CLI's JS bundle sits there **in the clear**: a contiguous UTF-8 region at `249,458,536..272,467,890` (21.94 MB) starting with `// @bun @bytecode @bun-cjs (function(exports, require, module, …)`. Two much smaller bundles of the same shape follow it at `272,467,923` and `272,470,125` — the loaders for `image-processor.node` and `audio-capture.node`.

Offsets move on every release; locating the region by scanning forward from the `// @bun @bytecode @bun-cjs` marker while the bytes stay valid UTF-8 text is what actually survives an update.

(function () {
    if (window.__ccx) return;

    var api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    var rawPost = api ? api.postMessage.bind(api) : function () {};

    if (api) {
        var proxy = {
            postMessage: function (m) {
                trackOutgoing(m);
                return rawPost(m);
            },
            getState: api.getState.bind(api),
            setState: api.setState.bind(api),
        };
        window.acquireVsCodeApi = function () { return proxy; };
    }

    var state = { profiles: [], active: null, sessionId: null, bindings: {} };
    var icons = {};
    var fallback = null;
    var registry = null;
    var ctx = null;
    // The session object (messages, busy, lastServedModel, send) — a different class from the context
    // object, and not reachable from it, so injection point #4 hands it over separately. Re-set on
    // every registration, which the app re-runs whenever the model selection changes, so a tab that
    // swaps its session object is followed rather than remembered.
    var sessionObj = null;
    var jsx = null;
    var chip = null;
    var overlay = null;
    var launchByChannel = {};
    var sessionByChannel = {};
    var activeChannelId = null;
    var pendingRestart = null;
    var searchSetter = null;
    var searchSeq = 0;
    var searchDebounceTimer = null;
    // uuid -> epoch ms, straight from the session's .jsonl. The page's own message.timestamp cannot be
    // trusted for anything but a live turn: its class defaults that field to Date.now(), and replayed
    // history is rebuilt without one, so a resumed transcript reports "now" for every past message.
    var messageTimes = {};
    var messageTimesSession = null;

    function send(message) {
        rawPost(message);
    }

    function trackOutgoing(m) {
        if (!m || typeof m.type !== 'string') return;
        if (m.type === 'launch_claude') {
            activeChannelId = m.channelId;
            launchByChannel[m.channelId] = {
                channelId: m.channelId,
                cwd: m.cwd,
                resume: m.resume,
                permissionMode: m.permissionMode,
                thinkingLevel: m.thinkingLevel,
            };
            if (m.resume) noteSession(m.channelId, m.resume);
        } else if (m.type === 'io_message' && m.channelId) {
            activeChannelId = m.channelId;
        }
    }

    function noteSession(channelId, sessionId) {
        if (!sessionId) return;
        sessionByChannel[channelId] = sessionId;
        if (channelId === activeChannelId && sessionId !== state.sessionId) {
            state.sessionId = sessionId;
            send({ type: 'ccx:session', sessionId: sessionId });
        }
    }

    function syncAction() {
        if (!registry) return;
        var trailing = jsx && state.active
            ? jsx('span', { className: 'ccx-prov-tag', children: state.active })
            : undefined;
        try {
            registry.registerAction(
                {
                    id: 'ccx-provider',
                    label: 'Switch provider…',
                    description: 'Change API provider profile for this session',
                    trailingComponent: trailing,
                },
                'Model',
                openPicker
            );
        } catch (e) {
            console.warn('ccx: registerAction failed', e);
        }
    }

    function syncChip() {
        if (registry) {
            if (chip) chip.remove();
            chip = null;
            return;
        }
        if (!chip) {
            chip = document.createElement('button');
            chip.className = 'ccx-chip';
            chip.title = 'Claude provider';
            chip.onclick = openPicker;
            document.body.appendChild(chip);
        }
        chip.textContent = '⇄ ' + (state.active || 'subscription');
    }

    function closePicker() {
        if (overlay) overlay.remove();
        overlay = null;
    }

    function openPicker() {
        closePicker();
        overlay = document.createElement('div');
        overlay.className = 'ccx-overlay';
        overlay.onclick = function (e) {
            if (e.target === overlay) closePicker();
        };

        var box = document.createElement('div');
        box.className = 'ccx-box';

        var title = document.createElement('div');
        title.className = 'ccx-title';
        title.textContent = 'API provider';
        box.appendChild(title);

        var hint = document.createElement('div');
        hint.className = 'ccx-hint';
        hint.textContent = state.sessionId ? 'Bound to this session' : 'No active session yet — applies on next launch';
        box.appendChild(hint);

        state.profiles.forEach(function (p) {
            var row = document.createElement('div');
            row.className = 'ccx-row';
            row.onclick = function () {
                send({
                    type: 'ccx:apply',
                    sessionId: sessionByChannel[activeChannelId] || state.sessionId,
                    channelId: activeChannelId,
                    name: p.name,
                });
                closePicker();
            };
            var mark = document.createElement('span');
            mark.className = 'ccx-mark';
            mark.textContent = p.name === state.active ? '●' : '○';
            var name = document.createElement('span');
            name.textContent = p.name;
            var model = document.createElement('span');
            model.className = 'ccx-model';
            model.textContent = p.model || '—';
            row.append(mark, name, model);
            box.appendChild(row);
        });

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        var onKey = function (e) {
            if (e.key === 'Escape') {
                closePicker();
                window.removeEventListener('keydown', onKey, true);
            }
        };
        window.addEventListener('keydown', onKey, true);
    }

    window.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || typeof d.type !== 'string') return;

        if (d.type === 'from-extension') {
            var msg = d.message;
            if (!msg) return;
            if (msg.type === 'io_message' && msg.message) {
                var inner = msg.message;
                if (inner.type === 'system' && inner.subtype === 'init' && inner.session_id)
                    noteSession(msg.channelId, inner.session_id);
                if (inner.type === 'system' && inner.subtype === 'compact_boundary')
                    onCompactBoundary(msg.channelId);
            } else if (msg.type === 'close_channel' && pendingRestart && msg.channelId === pendingRestart.channelId) {
                var job = pendingRestart;
                pendingRestart = null;
                clearTimeout(job.timer);
                setTimeout(function () { doLaunch(job); }, 150);
            }
            return;
        }

        if (d.type === 'ccx:state') {
            state = {
                profiles: d.profiles || [],
                active: d.active || null,
                models: d.models || null,
                bindings: d.bindings || {},
                sessionId: d.sessionId || state.sessionId,
            };
            adoptAttachmentPrompts(d.attachmentPrompts);
            // Retracted uuids arrive from the host; a session change resets the set, otherwise the
            // host's list merges in (the host only ever adds, so local in-flight additions survive).
            if (state.sessionId !== hiddenSession) {
                hiddenSession = state.sessionId;
                hiddenUuids = new Set();
                pendingRetractBefore = null;
                pendingRetractText = null;
                pendingRetractIdx = -1;
                pendingRetractResponse = false;
            }
            if (Array.isArray(d.hiddenMessages))
                for (var hi = 0; hi < d.hiddenMessages.length; hi++) hiddenUuids.add(d.hiddenMessages[hi]);
            syncAction();
            syncChip();
            decorateModelPicker();
            decorateSessionList();
            decorateTranscript();
            applyHidden();
        } else if (d.type === 'ccx:icons') {
            icons = d.icons || {};
            fallback = d.fallback || null;
            decorateSessionList();
        } else if (d.type === 'ccx:applied') {
            if (d.sessionId && !state.sessionId) state.sessionId = d.sessionId;
            restartChannel(d.name);
        } else if (d.type === 'ccx:searchResults') {
            // A later keystroke may already have moved past this — only the newest request's answer counts.
            if (d.seq !== searchSeq || !searchSetter) return;
            searchSetter(d.matches && d.matches.length ? new Set(d.matches) : null);
        } else if (d.type === 'ccx:timestampsResult') {
            if (d.sessionId !== messageTimesSession) return;
            messageTimes = d.times || {};
            decorateTranscript();
        }
    });

    var ALIAS_BY_LABEL = [
        { test: /^Default\b/, key: 'opus' },
        { test: /^Opus\b/, key: 'opus' },
        { test: /^Fable\b/, key: 'fable' },
        { test: /^Sonnet\b/, key: 'sonnet' },
        { test: /^Haiku\b/, key: 'haiku' },
    ];

    function decorateModelPicker() {
        if (!state.models) {
            document.querySelectorAll('.ccx-model-tag').forEach(function (n) {
                n.remove();
            });
            return;
        }
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var pending = [];
        var node;
        while ((node = walker.nextNode())) {
            var text = node.nodeValue && node.nodeValue.trim();
            if (!text || text.length > 24) continue;
            for (var i = 0; i < ALIAS_BY_LABEL.length; i++) {
                if (!ALIAS_BY_LABEL[i].test.test(text)) continue;
                var model = state.models[ALIAS_BY_LABEL[i].key];
                if (model) pending.push({ node: node, model: model });
                break;
            }
        }
        pending.forEach(function (item) {
            var host = item.node.parentElement;
            if (!host || host.dataset.ccxModel === item.model) return;
            var old = host.querySelector(':scope > .ccx-model-tag');
            if (old) old.remove();
            var tag = document.createElement('span');
            tag.className = 'ccx-model-tag';
            tag.textContent = item.model;
            host.appendChild(tag);
            host.dataset.ccxModel = item.model;
        });
    }

    // The session id is nowhere in the DOM: the history row is a bare <button> whose entire prop object
    // is {ref, className, onClick, onMouseMove, children}, and the id exists only as the React key at the
    // call site. React writes __reactFiber$<random> onto every host node it creates, but that pointer is
    // set at mount and never refreshed — with double buffering it is the stale alternate about every other
    // commit, so memoizedProps cannot be trusted. createWorkInProgress does copy `key` onto the alternate,
    // which makes fiber.key the one stale-proof read — and it is exactly the session id.
    var CCX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    var fiberKey = null;

    function fiberKeyOf(node) {
        if (fiberKey && fiberKey in node) return fiberKey;
        var names = Object.keys(node);
        for (var i = 0; i < names.length; i++) {
            if (names[i].indexOf('__reactFiber$') === 0) {
                fiberKey = names[i];
                return fiberKey;
            }
        }
        return null;
    }

    // The session's own fields are signals — read through .value
    function signalValue(v) {
        try {
            return v && typeof v === 'object' && 'value' in v ? v.value : undefined;
        } catch (e) {
            return undefined;
        }
    }

    // Two independent reads of the same value. A non-UUID key means the parent fell back to the array
    // index (the session had no id when it rendered), and a disagreement means the fiber is stale or
    // re-keyed — both give up, because a wrong provider icon is worse than none.
    function sessionIdOfRow(row) {
        var key = fiberKeyOf(row);
        var fiber = key ? row[key] : null;
        if (!fiber) return null;
        var fromKey = null;
        var fromProps = null;
        for (var d = 0; fiber && d < 4; d++, fiber = fiber.return) {
            if (!fromKey && typeof fiber.key === 'string' && CCX_UUID.test(fiber.key)) fromKey = fiber.key;
            if (!fromProps) {
                var session = fiber.memoizedProps && fiber.memoizedProps.session;
                var id = session && signalValue(session.sessionId);
                if (typeof id === 'string' && CCX_UUID.test(id)) fromProps = id;
            }
            if (fromKey && fromProps) break;
        }
        if (!fromKey) return null;
        if (fromProps && fromProps !== fromKey) return null;
        return fromKey;
    }

    function applyRowIcon(row) {
        var id = null;
        try {
            id = sessionIdOfRow(row);
        } catch (e) {
            id = null;
        }
        var name = (id && state.bindings && state.bindings[id]) || null;
        var uri = (name && icons[name]) || null;
        // A resolved session with no binding of its own ran on whatever settings.json said, so it takes
        // the host's fallback mark. An UNRESOLVED row takes nothing: guessing there could put a provider
        // on the wrong session, and a wrong icon is worse than none.
        var assumed = false;
        if (id && !uri && fallback && fallback.uri) {
            name = fallback.name;
            uri = fallback.uri;
            assumed = true;
        }
        var stamp = uri ? id + '|' + name + (assumed ? '|~' : '') : '';
        if (row.dataset.ccxRow === stamp) return;
        row.dataset.ccxRow = stamp;
        if (!uri) {
            row.removeAttribute('data-ccx-provider');
            row.style.removeProperty('--ccx-icon');
            row.removeAttribute('title');
            return;
        }
        // data-* and inline style survive React's commits; className does not — it is rewritten on every
        // isActive/isFocused change, so the icon must not hang off a class of ours
        row.setAttribute('data-ccx-provider', name);
        row.style.setProperty('--ccx-icon', 'url("' + uri + '")');
        row.title = 'Provider: ' + name + (assumed ? ' (default — not recorded for this session)' : '');
    }

    function decorateSessionList() {
        try {
            // The _<hash> suffix is a CSS-module content hash — match by prefix, never literally
            var rows = document.querySelectorAll('button[class*="sessionItem_"]');
            for (var i = 0; i < rows.length; i++) applyRowIcon(rows[i]);
        } catch (e) {
            /* an unrecognised list is a list without icons, not a broken webview */
        }
    }

    // --- Message timestamps, chat-app style --------------------------------------------------
    //
    // Each transcript turn is rendered from a `message` prop — {type, uuid, content, timestamp, …} —
    // carried straight from the .jsonl line that produced it, which is not otherwise exposed anywhere
    // in the DOM or in ccx:state. The same fiber read as sessionIdOfRow gets it: no signal unwrapping
    // needed here, `message` is a plain object, not a signal.
    //
    // Written as data-* + a CSS pseudo-element, the same way the session-list provider mark is: a real
    // child node risks React's own reconciliation of that bubble (most of all the assistant one, which
    // keeps re-rendering while a turn is still streaming) clobbering it on the next commit, where a
    // data attribute on the node React already owns survives untouched.
    // 'timestamp' in message alone is not enough to trust an object found this way — walking up through
    // memoized props of intermediate wrappers can surface something else entirely that happens to carry
    // a field of that name (a live status/notification object, for one, which is exactly why every
    // bubble was showing the same near-current time instead of its own). A transcript message has this
    // whole shape together; nothing else plausibly does.
    function isTranscriptMessage(message) {
        return (
            message &&
            typeof message === 'object' &&
            (message.type === 'user' || message.type === 'assistant') &&
            typeof message.uuid === 'string' &&
            Array.isArray(message.content) &&
            message.timestamp !== undefined &&
            message.timestamp !== null
        );
    }

    function messagePropOf(node) {
        var key = fiberKeyOf(node);
        var fiber = key ? node[key] : null;
        // Deeper than sessionIdOfRow's four hops — that one only has to clear the registry component;
        // this has to clear whatever wraps the specific content-block renderer inside a turn, which
        // varies with how many layers a given block type (text, tool use, thinking) happens to add.
        for (var d = 0; fiber && d < 10; d++, fiber = fiber.return) {
            var message = fiber.memoizedProps && fiber.memoizedProps.message;
            if (isTranscriptMessage(message)) return message;
        }
        return null;
    }

    function formatMessageTime(date) {
        try {
            return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
        } catch (e) {
            return '';
        }
    }

    function dayKey(date) {
        return date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate();
    }

    // "Today" / "Yesterday" through Intl.RelativeTimeFormat rather than a hand-rolled table — it is
    // already locale-correct, and every language this needs it in is one the runtime already knows.
    function formatDaySeparator(date) {
        var today = new Date();
        var diffDays = Math.round(
            (new Date(today.getFullYear(), today.getMonth(), today.getDate()) -
                new Date(date.getFullYear(), date.getMonth(), date.getDate())) /
                86400000
        );
        if (diffDays === 0 || diffDays === 1) {
            try {
                return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-diffDays, 'day');
            } catch (e) {
                /* fall through to a plain date */
            }
        }
        try {
            var opts =
                date.getFullYear() === today.getFullYear()
                    ? { day: 'numeric', month: 'long' }
                    : { day: 'numeric', month: 'long', year: 'numeric' };
            return new Intl.DateTimeFormat(undefined, opts).format(date);
        } catch (e) {
            return date.toDateString();
        }
    }

    // The .jsonl is fetched once per session. Live turns are not in it yet and do not need to be:
    // a message created in this page during this session carries a real Date.now() from its own
    // construction, so the in-page value is right for exactly the messages the file lacks.
    function ensureMessageTimes() {
        var id = state.sessionId;
        if (!id || id === messageTimesSession) return;
        messageTimesSession = id;
        messageTimes = {};
        send({ type: 'ccx:timestamps', sessionId: id });
    }

    function messageDate(message) {
        if (!message) return null;
        var ms = message.uuid ? messageTimes[message.uuid] : undefined;
        var date = ms ? new Date(ms) : message.timestamp ? new Date(message.timestamp) : null;
        return date && !isNaN(date.getTime()) ? date : null;
    }

    // Real child nodes, not pseudo-elements. An assistant bubble has BOTH of its pseudo-element slots
    // spoken for by the app itself: `.timelineMessage_:before` is the coloured status dot, and
    // `.timelineMessage_:after` is the vertical timeline rail — with `top:18px` on the first message of
    // a run, `height:18px` on the last, and `display:none` on a lone one. Generating content into
    // either slot silently replaces that, which is what first stretched the rail and then lost it
    // outright. Nothing about them may be touched, so the timestamp needs nodes of its own.
    //
    // Appended rather than prepended: React reconciles by walking references it already holds, and an
    // unknown node at the end stays out of the way of its insertBefore calls. Position is decided in
    // CSS instead — the time is absolute, the date pill uses flex `order` — so neither depends on where
    // in the child list it actually sits. If a commit does drop one, the MutationObserver pass puts it
    // back within its 60 ms debounce.
    function ensureLabel(node, className, tag) {
        for (var i = 0; i < node.children.length; i++)
            if (node.children[i].className === className) return node.children[i];
        var el = document.createElement(tag);
        el.className = className;
        node.appendChild(el);
        return el;
    }

    function dropLabel(node, className) {
        for (var i = 0; i < node.children.length; i++)
            if (node.children[i].className === className) {
                node.children[i].remove();
                return;
            }
    }

    function decorateTranscript() {
        try {
            ensureMessageTimes();
            // Same selector interruptIsCurrent() already reads the transcript with — document order,
            // both message kinds.
            var nodes = document.querySelectorAll('[data-testid="assistant-message"], [class*="userMessageContainer_"]');
            var prevDay = null;
            // Some bubbles render a second matching container inside themselves, and both fibers lead to
            // the same message — decorating both printed the same time twice, one directly under the
            // other. Document order guarantees an ancestor is seen before its descendant, so keeping the
            // outermost of each nest is enough.
            var decorated = [];
            for (var i = 0; i < nodes.length; i++) {
                var node = nodes[i];
                var nested = false;
                for (var j = 0; j < decorated.length; j++)
                    if (decorated[j].contains(node)) {
                        nested = true;
                        break;
                    }
                var date = nested ? null : messageDate(messagePropOf(node));
                if (!date) {
                    delete node.dataset.ccxTime;
                    delete node.dataset.ccxDate;
                    dropLabel(node, 'ccx-msg-time');
                    dropLabel(node, 'ccx-msg-date');
                    continue;
                }
                decorated.push(node);
                var time = formatMessageTime(date);
                // The attribute is what opens the gutter in CSS; the node is what fills it.
                if (node.dataset.ccxTime !== time) node.dataset.ccxTime = time;
                var timeEl = ensureLabel(node, 'ccx-msg-time', 'span');
                if (timeEl.textContent !== time) timeEl.textContent = time;
                var key = dayKey(date);
                if (key !== prevDay) {
                    var label = formatDaySeparator(date);
                    if (node.dataset.ccxDate !== label) node.dataset.ccxDate = label;
                    var dateEl = ensureLabel(node, 'ccx-msg-date', 'div');
                    if (dateEl.textContent !== label) dateEl.textContent = label;
                } else if (node.dataset.ccxDate) {
                    delete node.dataset.ccxDate;
                    dropLabel(node, 'ccx-msg-date');
                }
                prevDay = key;
            }
        } catch (e) {
            /* no timestamps is a plainer transcript, not a broken one */
        }
    }

    function watchPicker() {
        var timer = null;
        new MutationObserver(function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                decorateModelPicker();
                decorateSessionList();
                decorateTranscript();
                applyHidden();
                syncAttachmentPrompt();
                syncResumePrompt();
            }, 60);
        }).observe(document.body, { childList: true, subtree: true });
    }

    function toast(message) {
        var bar = document.createElement('div');
        bar.className = 'ccx-toast';
        bar.textContent = message;
        document.body.appendChild(bar);
        setTimeout(function () { bar.remove(); }, 6000);
    }

    // --- Quote selection ---------------------------------------------------------------------
    //
    // VS Code draws the webview's Cut/Copy/Paste menu itself, and an extension can only add to it by
    // contributing `menus."webview/context"` in the extension manifest. Patching an installed
    // extension's package.json is not viable: the scanned manifest is cached against the mtime of
    // extensions.json, so the edit either does nothing or trips the "Extensions have been modified
    // on disk" error. What the page *can* do is pre-empt the menu entirely — VS Code's webview
    // preload leads its own handler with `if (e.defaultPrevented) return;`, so calling
    // preventDefault() means its menu is never even requested. That is the whole mechanism.
    //
    // It is used as narrowly as possible: only on a right-click inside a non-empty transcript
    // selection. Everywhere else the stock menu is left alone, so Cut/Copy/Paste in the composer
    // and everything outside the transcript keep working untouched.

    var menu = null;
    var selectionSnapshot = null;

    // The composer's own glyphs are transparent (`color:#0000`) — what the user reads is a sibling
    // mirror element React renders from state. Writing to the DOM without going through their input
    // path therefore produces text that is not stale but *invisible*, so every insert below is an
    // execCommand that fires their `oninput`.
    function composerEl() {
        return document.querySelector('[role="textbox"][aria-label="Message input"]');
    }

    // While a permission request is pending the app sets `display:none` on the composer's container.
    // execCommand refuses to edit a hidden contenteditable and returns false, so the item must not be
    // offered at all in that state — inserting "successfully" into an invisible box is worse.
    function composerReady() {
        var el = composerEl();
        return el && el.offsetParent !== null ? el : null;
    }

    function fencedLanguage(node) {
        var pre = node && node.nodeType === 1 ? node : node && node.parentElement;
        pre = pre && pre.closest ? pre.closest('pre') : null;
        if (!pre) return null;
        var code = pre.querySelector('code');
        var m = code && /(?:^|\s)language-([\w+-]+)/.exec(code.className || '');
        return { lang: m ? m[1] : '' };
    }

    // Selected transcript text is rendered output, not the original markdown — links and emphasis are
    // already flattened by the time it reaches us, and there is no reliable way back to the source.
    // Quoting what the user actually sees is the honest reading of "quote selection". Code is the one
    // case worth special-handling: a selection sitting inside a <pre> becomes a fence, because
    // blockquoting code destroys it.
    function quoteText(sel) {
        var text = sel.toString().replace(/\r\n?/g, '\n').replace(/\s+$/, '');
        if (!text) return '';

        var fence = fencedLanguage(sel.anchorNode);
        if (fence && fencedLanguage(sel.focusNode)) {
            return '```' + fence.lang + '\n' + text + '\n```';
        }
        return text
            .split('\n')
            .map(function (line) {
                var trimmed = line.replace(/\s+$/, '');
                return trimmed ? '> ' + trimmed : '>';
            })
            .join('\n');
    }

    // One execCommand per line, with insertLineBreak between them. A single insertText carrying the
    // newlines is what the app itself uses for @-mentions, but it splits a multi-line payload into
    // <div> blocks and mangles the text; line-at-a-time lands it verbatim.
    function insertIntoComposer(el, text, trailingBreak) {
        el.focus();
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
            if (i && !document.execCommand('insertLineBreak')) return false;
            if (lines[i] && !document.execCommand('insertText', false, lines[i])) return false;
        }
        // A trailing break would leave the caret before it rather than after, so the blank line the
        // user needs is inserted as the separator for whatever they type next.
        return trailingBreak === false ? true : document.execCommand('insertLineBreak');
    }

    // --- Attachment with no text ---------------------------------------------------------------
    //
    // An image alone cannot be sent. Submit starts with `let je = te.current?.textContent?.trim()||"";
    // if(!je) return;`, and the send button is `disabled: !busy && !canSendMessage` where
    // canSendMessage is `!!v.trim()` — so with an empty composer the button is genuinely disabled and
    // does not even emit a click. Intercepting the send is therefore impossible; the only way through
    // is to make the text non-empty, which is what enables their button by their own rule.
    //
    // The draft is written the moment the attachment appears rather than at submit time, so the user
    // sees exactly what will be sent and can edit or replace it before pressing Enter.

    // The wording follows the language from /config. host.js resolves ~/.claude/settings.json into
    // these four finished sentences and ships them in ccx:state, so this side only has to decide which
    // of them fits what is attached — and a /config change repaints them without a reload.
    //
    // These English defaults are what stays in place if a host that predates the field is loaded, and
    // are also what an unrecognised language resolves to. To reword any language, edit LANGUAGES in
    // host.js; this table is only the fallback.
    var ATTACHMENT_PROMPTS = {
        image: 'Analyse the image in the context of this conversation',
        images: 'Analyse the images in the context of this conversation',
        attachment: 'Analyse the attachment in the context of this conversation',
        attachments: 'Analyse the attachments in the context of this conversation',
    };

    // All or nothing: a half-filled table would mean one attachment count silently drops to English
    // while the rest are translated, which reads as a bug in the wording rather than in the message.
    function adoptAttachmentPrompts(next) {
        if (!next) return;
        var keys = ['image', 'images', 'attachment', 'attachments'];
        for (var i = 0; i < keys.length; i++) if (typeof next[keys[i]] !== 'string' || !next[keys[i]]) return;
        ATTACHMENT_PROMPTS = next;
        // The resume and retract prompts ride on the same payload.
        if (typeof next.resume === 'string' && next.resume) RESUME_PROMPT = next.resume;
        if (typeof next.retract === 'string' && next.retract) RETRACT_TEMPLATE = next.retract;
    }

    var promptedForAttachments = false;

    function attachmentChips() {
        var box = document.querySelector('[class*="attachedFilesContainer_"]');
        // Every chip carries its own remove button; counting those is steadier than counting children,
        // which would also pick up whatever wrapper the app decides to add around them.
        return box ? Array.prototype.slice.call(box.querySelectorAll('button[title="Remove attachment"]')) : [];
    }

    // A chip renders the thumbnail as an <img> only when the file is an image; a document gets an icon
    // component instead. That is the difference the wording needs.
    function attachmentNoun(chips) {
        var box = document.querySelector('[class*="attachedFilesContainer_"]');
        var images = box ? box.querySelectorAll('img[class*="thumbIcon_"]').length : 0;
        if (images === chips.length) return chips.length > 1 ? 'images' : 'image';
        return chips.length > 1 ? 'attachments' : 'attachment';
    }

    function syncAttachmentPrompt() {
        try {
            var chips = attachmentChips();
            if (!chips.length) {
                // Reset only when the last attachment is gone, so clearing the draft by hand does not
                // immediately get it written back — that would be the feature fighting the user.
                promptedForAttachments = false;
                return;
            }
            if (promptedForAttachments) return;

            var el = composerReady();
            if (!el || el.textContent.trim()) return;

            promptedForAttachments = true;
            insertIntoComposer(el, ATTACHMENT_PROMPTS[attachmentNoun(chips)], false);
        } catch (err) {
            console.warn('ccx: attachment prompt failed', err);
        }
    }

    // --- Resume after terminal state --------------------------------------------------------------
    //
    // When the model hits an error or the user interrupts, the conversation stops and the only way
    // forward is to type "continue" by hand. This injects that prompt automatically when the composer
    // is empty and one of those halt states is visible in the transcript.
    //
    // Two states, distinguished by their markup:
    //   - Error banner:      [class*="banner_"][data-color="error"]
    //   - Interrupt message: [class*="interruptedMessage_"]
    //
    // The prompt is injected once per terminal state. It resets when the state clears (the user sends
    // a message and the banner disappears), so the next terminal gets a fresh prompt.

    var RESUME_PROMPT = 'Continue from where you stopped';
    var promptedForResume = false;
    var lastResumeState = null;

    // An interrupt marker is transcript history: it stays in the DOM long after the conversation has
    // moved on, so its presence alone does not mean anything is halted NOW. It is a live halt only
    // while nothing renders after it — the moment an answer or a newer message follows, that
    // interrupt is a past event being displayed, not a state to resume.
    function interruptIsCurrent() {
        var halts = document.querySelectorAll('[class*="interruptedMessage_"]');
        if (!halts.length) return false;
        var halt = halts[halts.length - 1];
        if (halt.offsetParent === null) return false;
        var messages = document.querySelectorAll(
            '[data-testid="assistant-message"], [class*="userMessageContainer_"]',
        );
        if (!messages.length) return true;
        // querySelectorAll returns document order, so the last entry is the newest message. The halt
        // marker renders inside its own user-message container, so "inside the newest message" and
        // "nothing follows it" both mean the same thing: the halt is the end of the transcript.
        var last = messages[messages.length - 1];
        return last.contains(halt) || !(halt.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING);
    }

    // Check for the two halt states worth resuming: a real error (the 429 that hits a limit is an
    // error, so it lands here too) and a trailing user interrupt. Deliberately NOT the warning
    // banner — that one shows "you are approaching a limit" while the run is perfectly healthy, so
    // filling the composer there would read as the prompt interrupting a live conversation rather
    // than resuming a halted one.
    function detectTerminalState() {
        var errorBanner = document.querySelector('[class*="banner_"][data-color="error"]');
        if (errorBanner && errorBanner.offsetParent !== null) return 'error';
        if (interruptIsCurrent()) return 'interrupt';
        return null;
    }

    // The send button swaps its icon between send and stop: stopIcon_ only renders while the model is
    // generating. That is the difference between "the user just sent the prompt and the answer is on
    // its way" and "the run actually halted and is waiting" — the interrupt message stays in the
    // transcript either way, so it cannot tell them apart on its own.
    function modelBusy() {
        var stop = document.querySelector('[class*="stopIcon_"]');
        return Boolean(stop && stop.offsetParent !== null);
    }

    function syncResumePrompt() {
        try {
            var state = detectTerminalState();
            // While the model is generating there is nothing to resume — the run is in progress, not
            // halted. This also clears the flag from the last halt, so the next halt gets a prompt.
            if (!state || modelBusy()) {
                promptedForResume = false;
                lastResumeState = null;
                return;
            }

            // Idle and halted. Don't re-inject for the same halt, but do inject if the state changed
            // (e.g., the error cleared, then the user interrupted).
            if (promptedForResume && lastResumeState === state) return;

            var el = composerReady();
            if (!el || el.textContent.trim()) return;

            insertIntoComposer(el, RESUME_PROMPT, false);
            promptedForResume = true;
            lastResumeState = state;
        } catch (err) {
            console.warn('ccx: resume prompt failed', err);
        }
    }

    function closeMenu() {
        if (menu) menu.remove();
        menu = null;
        window.removeEventListener('keydown', onMenuKey, true);
        window.removeEventListener('scroll', closeMenu, true);
        window.removeEventListener('blur', closeMenu, true);
        document.removeEventListener('mousedown', onMenuOutside, true);
    }

    function onMenuKey(e) {
        if (e.key === 'Escape') closeMenu();
    }

    function onMenuOutside(e) {
        if (menu && !menu.contains(e.target)) closeMenu();
    }

    function menuItem(label, run) {
        var row = document.createElement('div');
        row.className = 'ccx-menu-item';
        row.textContent = label;
        row.onclick = function () {
            closeMenu();
            run();
        };
        return row;
    }

    function menuSeparator() {
        var row = document.createElement('div');
        row.className = 'ccx-menu-sep';
        return row;
    }

    function openMenu(x, y, items) {
        closeMenu();
        menu = document.createElement('div');
        menu.className = 'ccx-menu';
        // Without this the mousedown collapses the selection before the click handler reads it, and
        // the highlight disappears from under the menu while it is open.
        menu.onmousedown = function (e) { e.preventDefault(); };
        items.forEach(function (item) { menu.appendChild(item); });

        // Measure before showing, or the box paints once at the origin on its way to the cursor.
        menu.style.visibility = 'hidden';
        document.body.appendChild(menu);
        var w = menu.offsetWidth;
        var h = menu.offsetHeight;
        menu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
        menu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
        menu.style.visibility = '';

        window.addEventListener('keydown', onMenuKey, true);
        window.addEventListener('scroll', closeMenu, true);
        window.addEventListener('blur', closeMenu, true);
        document.addEventListener('mousedown', onMenuOutside, true);
    }

    // --- Retract the last message -------------------------------------------------------------
    //
    // The stock "Rewind to…" picker restores a file checkpoint, forks the conversation and puts the
    // text back in the composer — a fork, which is exactly what this replaces. Retracting keeps the
    // session: the erroneous message and the assistant's answer to it are hidden from the transcript,
    // and the agent is told — under the hood, in a user turn that is hidden the moment it renders —
    // that the message was a mistake and should be ignored. The turn stays in the .jsonl, so the agent
    // keeps the context; only the view drops it. The hidden uuids are persisted per session on the
    // host, so a resume re-hides them and content search skips them.
    var RETRACT_TEMPLATE = 'The message «%s» was a mistake — ignore it and your response to it.';
    var RETRACT_QUOTE_LEN = 200;
    var hiddenUuids = new Set();
    var hiddenSession = null;
    // The retract accounts for two more turns than the one being retracted: the hidden "ignore it"
    // instruction, and the assistant's answer to it (which would otherwise dangle as an orphan reply
    // to nothing). The instruction's uuid is only knowable once send() has appended the turn, so these
    // fields track the search until both turns are found and hidden.
    var pendingRetractBefore = null;      // messages.value index where the instruction turn should land
    var pendingRetractText = null;        // the instruction text, a backstop if the index shifts
    var pendingRetractIdx = -1;           // the instruction turn's index, once found
    var pendingRetractResponse = false;   // true while the instruction's answer is still to hide

    function messageText(m) {
        if (!m || !Array.isArray(m.content)) return '';
        var parts = [];
        for (var i = 0; i < m.content.length; i++) {
            var b = m.content[i];
            // A message's content is an array of the app's block wrappers (class Bp), not the raw
            // blocks — the raw block sits one level down at block.content ({type:"text", text}). The
            // string branch guards the app's older string-content shape (its LX constructor).
            var block = b && b.content;
            if (typeof block === 'string') { parts.push(block); continue; }
            if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        }
        return parts.join('\n');
    }

    // The last message the user actually sent — the one "taking back the last message" refers to.
    // isSynthetic marks the app's own injected turns, which are not the user's to retract.
    function lastUserMessage() {
        var s = activeSession();
        if (!s) return null;
        var msgs = s.messages && s.messages.value;
        if (!Array.isArray(msgs)) return null;
        for (var i = msgs.length - 1; i >= 0; i--) {
            var m = msgs[i];
            // A retracted turn is already accounted for — the previous message is the one the user
            // gets to take back next.
            if (m && m.type === 'user' && !m.isSynthetic && !(m.uuid && hiddenUuids.has(m.uuid)))
                return { index: i, uuid: m.uuid, text: messageText(m) };
        }
        return null;
    }

    function canRetract() {
        var s = activeSession();
        if (!s) return false;
        if (s.busy && s.busy.value) return false;
        return lastUserMessage() !== null;
    }

    function persistHidden(uuids) {
        if (!uuids || !uuids.length) return;
        send({ type: 'ccx:hideMessages', sessionId: state.sessionId, uuids: uuids });
    }

    function hideNow(uuids) {
        var fresh = [];
        for (var i = 0; i < uuids.length; i++) {
            if (typeof uuids[i] === 'string' && !hiddenUuids.has(uuids[i])) {
                hiddenUuids.add(uuids[i]);
                fresh.push(uuids[i]);
            }
        }
        if (fresh.length) persistHidden(fresh);
        applyHidden();
    }

    // Pull the erroneous message back into the composer for editing — this is the "edit the last
    // message" half of the gesture. Writing textContent directly replaces whatever draft was already
    // there (retract means "rewrite that message", not "append to what I was typing"), and matches the
    // app's own setInputText (`st`): it assigns ne.current.textContent = ae and syncs the draft signal.
    // execCommand must NOT be used here: insertText on a contenteditable="plaintext-only" box only
    // lands when a live, collapsed selection is in place, and the select-all + delete that would clear
    // the old draft leaves that selection invalid — insertText then reports success while the DOM stays
    // empty, so the field reads blank. A direct textContent write always lands; the synthetic input
    // below makes the app's onInput (`os`) read it back and sync the draft signal, so the app's
    // "clear the composer when the draft is empty" effect (`if(ne.current&&v==="")…`) does not wipe it.
    function replaceComposerText(text) {
        var el = composerReady();
        if (!el) return false;
        el.focus();
        el.textContent = text;
        var range = document.createRange();
        var sel = window.getSelection();
        if (sel) {
            range.selectNodeContents(el);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        }
        if (typeof el.dispatchEvent === 'function') {
            var evt;
            try {
                evt = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text });
            } catch (err) {
                evt = null;
            }
            if (!evt) {
                try { evt = new Event('input', { bubbles: true }); } catch (err2) { evt = null; }
            }
            if (evt) el.dispatchEvent(evt);
        }
        return true;
    }

    function retractLastMessage() {
        var s = activeSession();
        if (!s) return toast('No active session.');
        if (s.busy && s.busy.value) return toast('Wait for the current response before retracting.');
        var last = lastUserMessage();
        if (!last) return toast('Nothing to retract.');

        // Everything from the erroneous message to the end of the list is the failed exchange: the
        // message itself and whatever the agent answered to it.
        var msgs = s.messages.value;
        var toHide = [];
        for (var i = last.index; i < msgs.length; i++) {
            var m = msgs[i];
            if (m && typeof m.uuid === 'string') toHide.push(m.uuid);
        }
        var quote = (last.text || '').replace(/\s+/g, ' ').trim();
        if (quote.length > RETRACT_QUOTE_LEN) quote = quote.slice(0, RETRACT_QUOTE_LEN) + '…';
        var instruction = RETRACT_TEMPLATE.replace('%s', quote || '…');

        hideNow(toHide);
        // Put the message back in the composer so it can be corrected and re-sent; the instruction
        // below is what tells the agent to ignore the old copy it still holds in context.
        if (last.text && !replaceComposerText(last.text))
            toast('Retracted — paste the message text into the composer to resend.');

        // The instruction's own uuid is only knowable once send() has appended the turn. applyHidden
        // resolves it the moment the turn lands — here, when the send settles, and again from the DOM
        // observer — and then hides the instruction's answer the moment it appears. The pending state
        // is cleared by applyHidden, not by the send resolving, so the turn can never outlive its own
        // hiding.
        pendingRetractBefore = msgs.length;
        pendingRetractText = instruction;

        var sent;
        try {
            sent = s.send(instruction);
        } catch (err) {
            pendingRetractBefore = null;
            pendingRetractText = null;
            toast('Could not retract the message.');
            return;
        }
        if (sent && typeof sent.then === 'function') {
            sent.then(
                function () { applyHidden(); },
                function () {
                    pendingRetractBefore = null;
                    pendingRetractText = null;
                    toast('Could not retract the message.');
                },
            );
            // If the turn never materialises (a send that settles in an unusual way), let the pending
            // state expire rather than hide an unrelated later message.
            window.setTimeout(function () {
                if (pendingRetractBefore !== null) {
                    pendingRetractBefore = null;
                    pendingRetractText = null;
                }
            }, 30000);
        }
    }

    // Three jobs, called from the DOM observer and from ccx:state. First it accounts for the retract's
    // own turns — the hidden "ignore it" instruction, then the assistant's answer to it — by finding
    // their uuids in messages.value the moment they appear; then it hides every message whose uuid is
    // in the set. Hiding rides on a data attribute rather than inline style, the same way the
    // timestamps do — an assistant bubble keeps re-rendering while a turn streams.
    function applyHidden() {
        var s = activeSession();
        var msgs = s && s.messages && s.messages.value;
        if (pendingRetractBefore !== null && Array.isArray(msgs)) {
            for (var fi = pendingRetractBefore; fi < msgs.length; fi++) {
                var m = msgs[fi];
                if (!m || m.type !== 'user' || typeof m.uuid !== 'string') continue;
                // The turn lands exactly where the retract left off; the text check is a backstop for
                // any array reshuffling between the capture and the append.
                if (fi !== pendingRetractBefore && messageText(m) !== pendingRetractText) continue;
                pendingRetractIdx = fi;
                pendingRetractBefore = null;
                pendingRetractText = null;
                pendingRetractResponse = true;
                if (!hiddenUuids.has(m.uuid)) {
                    hiddenUuids.add(m.uuid);
                    persistHidden([m.uuid]);
                }
                break;
            }
        }
        if (pendingRetractResponse && Array.isArray(msgs)) {
            for (var ai = pendingRetractIdx + 1; ai < msgs.length; ai++) {
                var a = msgs[ai];
                if (!a || typeof a.uuid !== 'string') continue;
                if (a.type === 'assistant') {
                    pendingRetractResponse = false;
                    if (!hiddenUuids.has(a.uuid)) {
                        hiddenUuids.add(a.uuid);
                        persistHidden([a.uuid]);
                    }
                    break;
                }
            }
        }
        try {
            var nodes = document.querySelectorAll('[data-testid="assistant-message"], [class*="userMessageContainer_"]');
            var seen = [];
            for (var i = 0; i < nodes.length; i++) {
                var node = nodes[i];
                var msg = messagePropOf(node);
                if (!msg) continue;
                // Document order puts an ancestor before its descendant, so keeping only the
                // outermost node of each message hides the whole bubble once, the way the timestamp
                // pass keeps the outermost bubble for its label.
                var nested = false;
                for (var j = 0; j < seen.length; j++)
                    if (seen[j].contains(node)) { nested = true; break; }
                if (nested) continue;
                seen.push(node);
                if (msg.uuid && hiddenUuids.has(msg.uuid)) node.setAttribute('data-ccx-hidden', '');
                else node.removeAttribute('data-ccx-hidden');
            }
        } catch (e) {
            /* a message that cannot be hidden is one that stays visible */
        }
    }

    // Ctrl+Shift+Z. In a contenteditable that is redo, so the composer gives redo up for this — undo
    // is untouched, and what redo would restore there is a line of prose. It is a trade, not a free
    // key, which is also why the event is only swallowed when there is actually a message to retract.
    function onRetractKey(e) {
        if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
        if ((e.key || '').toLowerCase() !== 'z') return;
        if (!canRetract()) return;
        e.preventDefault();
        e.stopPropagation();
        retractLastMessage();
    }

    function rangeHasPoint(range, x, y) {
        var rects = range.getClientRects();
        for (var i = 0; i < rects.length; i++) {
            var r = rects[i];
            if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return true;
        }
        return false;
    }

    // A right-click outside a selection collapses it before the contextmenu event, so the live
    // selection alone cannot answer "did they click inside their selection". The snapshot is taken on
    // the mousedown that precedes it — and is only trusted when the click actually landed on it,
    // otherwise a click elsewhere would quote text the user had left behind.
    function usableSelection(e) {
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) return sel;
        if (selectionSnapshot && rangeHasPoint(selectionSnapshot, e.clientX, e.clientY)) {
            var restored = window.getSelection();
            restored.removeAllRanges();
            restored.addRange(selectionSnapshot);
            return restored;
        }
        return null;
    }

    function onContextMenu(e) {
        try {
            // Positive gate on the transcript container. Matching the CSS-module prefix is the same
            // approach the session-list icons use; it fails closed — a renamed module means the item
            // stops appearing, never that the app's own menus break.
            if (!e.target.closest || !e.target.closest('[class*="messagesContainer_"]')) return;
            // The app has its own menu on markdown links; leave that one to it.
            if (e.target.closest('a[href]')) return;

            var sel = usableSelection(e);
            var text = sel ? quoteText(sel) : '';
            var items = [];

            if (text) {
                var quote = menuItem('Quote selection', function () {
                    var el = composerReady();
                    if (!el) return toast('The composer is not available right now.');
                    if (!insertIntoComposer(el, text)) toast('Could not insert the quote.');
                });
                if (!composerReady()) quote.classList.add('ccx-menu-disabled');
                items.push(quote);
                // preventDefault took the stock Copy away with the rest of the menu, so it comes back
                // here. The webview iframe is granted clipboard-write, so this is the whole story.
                items.push(
                    menuItem('Copy', function () {
                        navigator.clipboard.writeText(sel.toString()).catch(function () {
                            toast('Could not copy the selection.');
                        });
                    }),
                );
            }

            // Reached with no selection too, which is the point: over a transcript the stock menu is
            // three inert entries, so replacing it costs nothing there. The composer is outside
            // messagesContainer_ and keeps its own menu, which is the one where Paste matters.
            if (activeSession()) {
                if (items.length) items.push(menuSeparator());
                items.push(menuItem('Retract last message', retractLastMessage));
            }
            if (!items.length) return;

            e.preventDefault();
            e.stopPropagation();
            openMenu(e.clientX, e.clientY, items);
        } catch (err) {
            console.warn('ccx: context menu failed', err);
        }
    }

    function watchSelection() {
        document.addEventListener(
            'mousedown',
            function (e) {
                if (e.button !== 2) {
                    selectionSnapshot = null;
                    return;
                }
                var sel = window.getSelection();
                selectionSnapshot =
                    sel && !sel.isCollapsed && sel.toString().trim() ? sel.getRangeAt(0).cloneRange() : null;
            },
            true,
        );
        // Capture phase: React binds its delegated listeners on #root, so this runs first, and
        // stopPropagation() here also keeps VS Code's own window-level handler from seeing the event.
        document.addEventListener('contextmenu', onContextMenu, true);
        // Same reason for the capture phase, and it has to be the window: the composer stops some keys
        // at its own handler, and the composer is exactly where you are when you want this.
        window.addEventListener('keydown', onRetractKey, true);
    }

    function restartChannel(name) {
        var launch = launchByChannel[activeChannelId];
        var conn = ctx && ctx.comms && ctx.comms.connection && ctx.comms.connection.value;
        if (!activeChannelId || !conn || typeof conn.launchClaude !== 'function') {
            toast('Provider "' + name + '" will apply on the next session launch.');
            return;
        }
        if (pendingRestart) return;

        // What is resumed has to be a session the CLI has actually written: the id it announced on
        // this channel (system/init) or the one this channel was launched to resume. state.sessionId
        // is deliberately not a fallback — on a tab that has not sent anything yet the page already
        // holds a provisional id, and resuming that gives "No conversation found with session ID".
        // A tab with nothing said in it has nothing to lose: it restarts fresh, and the first
        // system/init binds the real session to the profile.
        var resume = sessionByChannel[activeChannelId] || (launch && launch.resume) || undefined;

        // A tab with history is offered a compaction first. The prompt cache never survives a provider
        // change anyway — the next backend has never seen this prefix — so the first turn pays for the
        // whole transcript either way; sending the compact summary instead of the raw history is the
        // one lever that makes that first turn cheaper, and it also keeps a longer conversation inside
        // a smaller window on the other side. It is a question, not a default: compaction discards
        // detail the user may be about to rely on.
        if (resume && canCompact()) return offerCompaction(name, resume);
        performRestart(name, resume);
    }

    // --- Compact before switching -------------------------------------------------------------
    //
    // The compaction is the stock one: the page's own send() with "/compact", the same thing the
    // command menu does. The CLI answers with a system/compact_boundary on the io_message stream we
    // already listen to; that is the moment the summary is written and the restart can go ahead. If
    // it never arrives — the model is stuck, or the turn errors — the switch is not held hostage:
    // after COMPACT_WAIT_MS it restarts uncompacted and says so.
    var COMPACT_WAIT_MS = 90000;
    var pendingCompact = null;

    function activeSession() {
        // The context object (class `t_e`) has no route to the session at all — the session is class
        // `MX`, and reading an `activeSession` field off the context was the bug: always undefined, so
        // canCompact() said no and the offer never appeared. It arrives through injection point #4.
        var s = sessionObj;
        return s && typeof s.send === 'function' ? s : null;
    }

    // "Switch model… → <model>" in the command menu is the stock indicator of lastServedModel, which the
    // page fills from the model on the last assistant turn — and it fills it while REPLAYING history
    // for a resume (loadFromMessages → processMessage per item), before the CLI has said a word. So
    // after a provider switch it names the model the old provider answered with, until the new one
    // answers. The stock reset lives in system/init and fires only when the session id changes, which
    // a --resume never does. Cleared here instead, on every restart of a switch, so the menu shows the
    // selection rather than a ghost from the transcript.
    function forgetServedModel() {
        try {
            var s = activeSession();
            if (s && s.lastServedModel && 'value' in s.lastServedModel) s.lastServedModel.value = undefined;
        } catch (err) {
            /* an indicator we could not reset is a stale label, not a broken switch */
        }
    }

    function canCompact() {
        var s = activeSession();
        if (!s) return false;
        // Nothing to compact on a transcript with no assistant turn yet, and no point asking while a
        // turn is already running — the compaction would queue behind it.
        var msgs = s.messages && s.messages.value;
        var hasAssistant = Array.isArray(msgs) && msgs.some(function (m) { return m && m.type === 'assistant'; });
        var busy = s.busy && s.busy.value;
        return hasAssistant && !busy;
    }

    function offerCompaction(name, resume) {
        var bar = document.createElement('div');
        bar.className = 'ccx-toast';
        var text = document.createElement('span');
        text.textContent = 'Switching to "' + name + '". Compact the conversation first?';
        var yes = document.createElement('button');
        yes.className = 'ccx-toast-btn';
        yes.textContent = 'Compact & switch';
        var no = document.createElement('button');
        no.className = 'ccx-toast-btn ccx-toast-btn-quiet';
        no.textContent = 'Switch as is';
        bar.append(text, yes, no);
        document.body.appendChild(bar);
        var done = false;
        var settle = function (compact) {
            if (done) return;
            done = true;
            bar.remove();
            if (compact) compactThenRestart(name, resume);
            else performRestart(name, resume);
        };
        yes.onclick = function () { settle(true); };
        no.onclick = function () { settle(false); };
        // Left unanswered, the switch still happens — the profile was already applied on the host, and
        // a toast that quietly outlives the decision would leave the tab claiming one provider while
        // running another.
        setTimeout(function () { settle(false); }, 20000);
    }

    function compactThenRestart(name, resume) {
        var s = activeSession();
        if (!s) return performRestart(name, resume);
        toast('Compacting before switching to "' + name + '"…');
        var job = { name: name, resume: resume, channelId: activeChannelId };
        job.timer = setTimeout(function () {
            if (pendingCompact !== job) return;
            pendingCompact = null;
            toast('Compaction did not finish — switching to "' + name + '" as is.');
            performRestart(name, resume);
        }, COMPACT_WAIT_MS);
        pendingCompact = job;
        try {
            var r = s.send('/compact');
            if (r && typeof r.catch === 'function') r.catch(function () { onCompactFailed(job); });
        } catch (err) {
            onCompactFailed(job);
        }
    }

    function onCompactFailed(job) {
        if (pendingCompact !== job) return;
        pendingCompact = null;
        clearTimeout(job.timer);
        toast('Could not compact — switching to "' + job.name + '" as is.');
        performRestart(job.name, job.resume);
    }

    // Called from the io_message listener the moment the CLI reports the boundary
    function onCompactBoundary(channelId) {
        var job = pendingCompact;
        if (!job || job.channelId !== channelId) return;
        pendingCompact = null;
        clearTimeout(job.timer);
        // The boundary is reported before the turn is fully wound down; a short beat lets the summary
        // land in the transcript before the channel is closed on top of it.
        setTimeout(function () { performRestart(job.name, job.resume); }, 400);
    }

    function performRestart(name, resume) {
        var launch = launchByChannel[activeChannelId];
        var conn = ctx && ctx.comms && ctx.comms.connection && ctx.comms.connection.value;
        if (!activeChannelId || !conn || typeof conn.launchClaude !== 'function') {
            toast('Provider "' + name + '" will apply on the next session launch.');
            return;
        }
        if (pendingRestart) return;
        forgetServedModel();
        toast('Switching to "' + name + '" — ' + (resume ? 'restarting session…' : 'starting fresh…'));
        var job = {
            channelId: activeChannelId,
            conn: conn,
            resume: resume,
            cwd: launch && launch.cwd,
            permissionMode: launch && launch.permissionMode,
            thinkingLevel: launch && launch.thinkingLevel,
        };
        job.timer = setTimeout(function () {
            if (pendingRestart === job) {
                pendingRestart = null;
                doLaunch(job);
            }
        }, 6000);
        pendingRestart = job;
        send({ type: 'close_channel', channelId: job.channelId });
    }

    function doLaunch(job) {
        try {
            job.conn.launchClaude(job.channelId, job.resume, job.cwd, job.permissionMode, job.thinkingLevel);
        } catch (err) {
            console.error('ccx: relaunch failed', err);
            toast('Could not restart the session — start a new conversation.');
        }
    }

    // --- Search sessions by content ------------------------------------------------------------
    //
    // The stock search box matches only a row's title and git branch, both already sitting in the
    // page. Matching the conversation itself needs the transcript, which the page does not hold for
    // rows outside the active tab — so title/branch matching stays instant and client-side, and a
    // query additionally goes to the host, which greps each visible session's file on disk and
    // reports back which ones actually contain it. The session list patch (injection point #4) hands
    // over the candidate ids and a setter for the result; this only debounces the request and the
    // response, so a fast typist does not fire one lookup per keystroke.
    //
    // Every call clears the previous result immediately, before scheduling anything: without that, a
    // stale Set from the last query would keep matching sessions under the new one for as long as the
    // debounce takes to resolve.
    function onSearchState(setter) {
        searchSetter = setter;
    }

    function onSearchQuery(query, sessionIds) {
        clearTimeout(searchDebounceTimer);
        var mySeq = ++searchSeq;
        if (searchSetter) searchSetter(null);
        var q = (query || '').trim();
        if (!q) return;
        searchDebounceTimer = setTimeout(function () {
            send({ type: 'ccx:searchContent', query: q, sessionIds: sessionIds || [], seq: mySeq });
        }, 250);
    }

    window.__ccx = {
        onRegistry: function (host, jsxFactory, session) {
            // The session is refreshed even when the rest is already wired: this hook fires on every
            // re-registration, and only the first one gets past the guard below.
            if (session) sessionObj = session;
            if (registry || !host || !host.commandRegistry) return;
            ctx = host;
            registry = host.commandRegistry;
            jsx = jsxFactory;
            syncAction();
            syncChip();
        },
        onSearchState: onSearchState,
        onSearchQuery: onSearchQuery,
        retract: retractLastMessage,
    };

    // styles
    var s = document.createElement('style');
    s.textContent = [
        '.ccx-chip{position:fixed;right:10px;bottom:8px;z-index:9999;font:11px var(--vscode-font-family);padding:2px 8px;border-radius:10px;cursor:pointer;color:var(--vscode-foreground);background:var(--vscode-badge-background);border:1px solid var(--vscode-widget-border, transparent)}',
        '.ccx-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35)}',
        '.ccx-box{min-width:280px;max-width:80vw;max-height:70vh;overflow:auto;padding:6px;border-radius:6px;font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border, var(--vscode-focusBorder));box-shadow:0 4px 16px rgba(0,0,0,.4)}',
        '.ccx-title{padding:6px 10px;opacity:.7;font-size:11px;text-transform:uppercase}',
        '.ccx-hint{padding:0 10px 6px;opacity:.55;font-size:11px}',
        '.ccx-row{display:flex;gap:8px;align-items:baseline;padding:6px 10px;border-radius:4px;cursor:pointer}',
        '.ccx-row:hover{background:var(--vscode-list-hoverBackground)}',
        '.ccx-mark{opacity:.7;width:1em}',
        '.ccx-model{margin-left:auto;opacity:.6;font-size:11px}',
        '.ccx-prov-tag{opacity:.7;font-size:11px;padding:1px 6px;border-radius:8px;background:var(--vscode-badge-background)}',
        '.ccx-model-tag{margin-left:6px;opacity:.55;font-size:10px;font-family:var(--vscode-editor-font-family, monospace)}',
        // The row is display:flex;align-items:center;gap:8px, so ::before simply becomes its leading flex
        // item and the flex:1 title still ellipsizes. No child node, so nothing for React to reconcile.
        'button[data-ccx-provider]::before{content:"";flex:0 0 auto;width:13px;height:13px;margin-right:-3px;border-radius:3px;background-image:var(--ccx-icon);background-size:contain;background-position:center;background-repeat:no-repeat;opacity:.9}',
        // A gutter, not a line of its own: pinned into the left margin the time sits beside the
        // message's opening line and costs no height at all, which is what the stock tool-call rows
        // already look like — rail, dot, time, content.
        //
        // Note what is NOT here: any ::before or ::after on the message itself. Both slots belong to
        // the app — `.timelineMessage_:before` is the status dot, `.timelineMessage_:after` is the
        // vertical rail (top:18px first in a run, height:18px last, display:none when alone). Writing
        // to either replaces it, which stretched the rail and then lost it. The labels are real child
        // nodes instead, and every stock rule about the rail keeps applying untouched.
        '[data-ccx-time]{padding-left:84px}',
        // Absolute labels keep the stock message layout and timeline untouched. A date-bearing bubble
        // reserves a small header inside itself, so the separator never floats over the previous bubble.
        '.ccx-msg-time{position:absolute;left:24px;top:8px;width:52px;height:1.5em;display:flex;align-items:center;white-space:nowrap;font-size:11px;line-height:1;opacity:.55;font-variant-numeric:tabular-nums;user-select:none;pointer-events:none}',
        '.ccx-msg-date{position:absolute;left:50%;top:4px;transform:translateX(-50%);width:fit-content;max-width:90%;white-space:nowrap;margin:0;padding:2px 10px;border-radius:10px;font-size:11px;text-align:center;opacity:.6;background:var(--vscode-badge-background);user-select:none}',
        // The date occupies this bubble's header; the time then stays beside the first content line.
        '[data-ccx-date]{padding-top:34px}',
        '[data-ccx-date] .ccx-msg-time{top:42px}',
        '.ccx-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:10001;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:6px;font:12px var(--vscode-font-family);color:var(--vscode-notifications-foreground, var(--vscode-foreground));background:var(--vscode-notifications-background, var(--vscode-editorWidget-background));border:1px solid var(--vscode-notificationCenter-border, var(--vscode-widget-border));box-shadow:0 4px 16px rgba(0,0,0,.4)}',
        '.ccx-toast-btn{font:12px var(--vscode-font-family);padding:3px 10px;border-radius:4px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:none}',
        '.ccx-toast-btn-quiet{color:var(--vscode-button-secondaryForeground, var(--vscode-foreground));background:var(--vscode-button-secondaryBackground, transparent);border:1px solid var(--vscode-button-border, var(--vscode-widget-border))}',
        '.ccx-toast-skip{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}',
        // Above the app's own .previewOverlay (z-index 1e4) and claudapter's toast, since it is opened
        // from a right-click that can land anywhere. Menu colours first, widget colours as the fallback.
        '.ccx-menu{position:fixed;z-index:10002;min-width:160px;padding:4px;border-radius:5px;font:13px var(--vscode-font-family);color:var(--vscode-menu-foreground, var(--vscode-foreground));background:var(--vscode-menu-background, var(--vscode-editorWidget-background));border:1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--vscode-focusBorder)));box-shadow:0 2px 12px rgba(0,0,0,.4)}',
        '.ccx-menu-item{padding:4px 22px 4px 10px;border-radius:3px;cursor:pointer;white-space:nowrap}',
        '.ccx-menu-item:hover{color:var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));background:var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground))}',
        '.ccx-menu-disabled{opacity:.45;pointer-events:none}',
        '.ccx-menu-sep{height:1px;margin:4px 6px;background:var(--vscode-menu-separatorBackground, var(--vscode-widget-border, rgba(128,128,128,.35)))}',
        // A retracted message (and the hidden "ignore it" turn) is dropped by a data attribute rather
        // than an inline style, so a React re-render of the bubble cannot bring it back.
        '[data-ccx-hidden]{display:none !important}',
    ].join('');
    document.head.appendChild(s);

    send({ type: 'ccx:get' });
    // Listeners go on `document`, which exists before <body> does, so this does not wait for the DOM.
    // It also has to be registered before VS Code's preload hooks the frame, which is why the injected
    // script is a classic inline <script> rather than a module.
    watchSelection();
    if (document.body) {
        syncChip();
        decorateSessionList();
        decorateTranscript();
        watchPicker();
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            syncChip();
            decorateSessionList();
            decorateTranscript();
            watchPicker();
        });
    }
})();
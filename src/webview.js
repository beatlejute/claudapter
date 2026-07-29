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

    var state = { profiles: [], active: null, sessionId: null };
    var registry = null;
    var ctx = null;
    var jsx = null;
    var chip = null;
    var overlay = null;
    var launchByChannel = {};
    var sessionByChannel = {};
    var activeChannelId = null;
    var pendingRestart = null;

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
                sessionId: d.sessionId || state.sessionId,
            };
            syncAction();
            syncChip();
            decorateModelPicker();
        } else if (d.type === 'ccx:applied') {
            if (d.sessionId && !state.sessionId) state.sessionId = d.sessionId;
            restartChannel(d.name);
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

    function watchPicker() {
        var timer = null;
        new MutationObserver(function () {
            clearTimeout(timer);
            timer = setTimeout(decorateModelPicker, 60);
        }).observe(document.body, { childList: true, subtree: true });
    }

    function toast(message) {
        var bar = document.createElement('div');
        bar.className = 'ccx-toast';
        bar.textContent = message;
        document.body.appendChild(bar);
        setTimeout(function () { bar.remove(); }, 6000);
    }

    function restartChannel(name) {
        var launch = launchByChannel[activeChannelId];
        var conn = ctx && ctx.comms && ctx.comms.connection && ctx.comms.connection.value;
        if (!activeChannelId || !conn || typeof conn.launchClaude !== 'function') {
            toast('Provider "' + name + '" will apply on the next session launch.');
            return;
        }
        if (pendingRestart) return;

        toast('Switching to "' + name + '" — restarting session…');
        var job = {
            channelId: activeChannelId,
            conn: conn,
            resume: sessionByChannel[activeChannelId] || state.sessionId || (launch && launch.resume) || undefined,
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

    window.__ccx = {
        onRegistry: function (host, jsxFactory) {
            if (registry || !host || !host.commandRegistry) return;
            ctx = host;
            registry = host.commandRegistry;
            jsx = jsxFactory;
            syncAction();
            syncChip();
        },
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
        '.ccx-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:10001;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:6px;font:12px var(--vscode-font-family);color:var(--vscode-notifications-foreground, var(--vscode-foreground));background:var(--vscode-notifications-background, var(--vscode-editorWidget-background));border:1px solid var(--vscode-notificationCenter-border, var(--vscode-widget-border));box-shadow:0 4px 16px rgba(0,0,0,.4)}',
        '.ccx-toast-btn{font:12px var(--vscode-font-family);padding:3px 10px;border-radius:4px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:none}',
        '.ccx-toast-skip{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}',
    ].join('');
    document.head.appendChild(s);

    send({ type: 'ccx:get' });
    if (document.body) {
        syncChip();
        watchPicker();
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            syncChip();
            watchPicker();
        });
    }
})();
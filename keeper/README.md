# Claudapter Keeper

A three-file companion extension for [Claudapter](https://github.com/beatlejute/claudapter). It carries
none of the patch: on every window it asks `~/.claude/claudapter/apply-patch.mjs` whether the installed
Claude Code bundle still has the hooks, and runs the patcher when an update has replaced them.

Nothing happens on a window where the bundle is already patched. When the patcher does run, a
notification offers **Reload Window**; when it stops because a signature no longer matches, the warning
points at `~/.claude/claudapter/keeper.log` and the extension is left clean and working.

The command **Claudapter: Apply patch to Claude Code** runs the same patcher on demand.

/** Scoped exception for the reviewed Claude noninteractive Goal, not other engines or schedulers. */
export function patchClaudeCommands(source, replace) {
  source = replace(source, 'function claudeLiveCommandCatalog(builtIns, snapshot) {', `function dshClaudeGoalCatalog(builtIns, snapshot) {
  const goal = snapshot?.commands.find(command => command.name === "goal");
  if (!goal) return builtIns;
  return { commands: [...builtIns.commands, {
    id: "claude.slash.goal", invocation: "/goal", label: "Goal",
    description: goal.description || "View, set or clear the native Claude goal",
    argumentMode: "text", kind: "command"
  }] };
}
function claudeLiveCommandCatalog(builtIns, snapshot) {`, 'Claude Goal exposed only when the live SDK advertises it');
  source = replace(source, 'mergeLiveHarnessCommands(builtIns, DYNAMIC_ID_PREFIX,', 'mergeLiveHarnessCommands(dshClaudeGoalCatalog(builtIns, snapshot), DYNAMIC_ID_PREFIX,', 'allow only Claude Goal without enabling other background commands');
  const list = source.includes('list: async () => ({ ok: true, value: this.#liveCommandCatalog() }),')
    ? 'list: async () => ({ ok: true, value: this.#liveCommandCatalog() }),'
    : 'list: async () => ({ ok: !0, value: this.#liveCommandCatalog() }),';
  source = replace(source, list, `list: async () => {
        if (this.#phase !== "open") return { ok: false, error: invalidState("Claude Code Session is not open") };
        try { await this.#ensureTransport(); }
        catch (error) { return { ok: false, error: startupFailure(error) }; }
        return { ok: true, value: this.#liveCommandCatalog() };
      },`, 'discover native commands on a cold Thread using SDK initialization only');
  return source;
}

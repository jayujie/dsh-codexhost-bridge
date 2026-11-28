export function patchAntigravityCollaboration(source, replace) {
  source = replace(
    source,
    `  #stopped = false;
  #disposal = null;
  constructor(directory, options) {`,
    `  #stopped = false;
  #disposal = null;
  #dshCollaboration = null;
  constructor(directory, options) {`,
    'track DSH collaboration bridge on AntigravityQuestionBridge',
  );

  source = replace(
    source,
    `      await writeFile3(path8.join(directory, ".agents", "hooks.json"), JSON.stringify({
        "codexhost-question-bridge": {
          PreToolUse: [
            {
              matcher: "^ask_question$",
              hooks: [
                {
                  type: "command",
                  command,
                  timeout: Math.ceil((options.timeoutMs ?? QUESTION_TIMEOUT_MS) / 1e3) + 15
                }
              ]
            }
          ]
        }
      }), "utf8");
      return bridge;`,
    `      bridge.#dshCollaboration = await dshSetupAntigravityCollaborationBridge({
        directory,
        sessionEnvironment: options.sessionEnvironment,
        bridgeEnvironment: bridge.environment,
        nodePath: process.execPath
      });
      await writeFile3(path8.join(directory, ".agents", "hooks.json"), JSON.stringify({
        "codexhost-question-bridge": {
          PreToolUse: [
            {
              matcher: "^ask_question$",
              hooks: [
                {
                  type: "command",
                  command,
                  timeout: Math.ceil((options.timeoutMs ?? QUESTION_TIMEOUT_MS) / 1e3) + 15
                }
              ]
            }
          ]
        },
        ...bridge.#dshCollaboration.hooks
      }), "utf8");
      return bridge;`,
    'mount per-turn Antigravity collaboration MCP plugin and unified wake hook',
  );

  source = replace(
    source,
    `  stop() {
    if (this.#stopped)
      return;
    this.#stopped = true;
    for (const pending of this.#pending.values()) {
      this.#finish(pending, "cancelled", "The codexhost Turn ended before an answer was received. Do not infer a user choice.");
    }
  }
  dispose() {
    this.stop();
    this.#disposal ??= (async () => {
      await new Promise((resolve) => {
        this.#server.close(() => resolve());
        this.#server.closeAllConnections();
      });
      if (this.#options.directory === void 0) {
        await rm3(this.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    })();
    return this.#disposal;
  }`,
    `  stop() {
    if (this.#stopped)
      return;
    this.#stopped = true;
    this.#dshCollaboration?.stop();
    for (const pending of this.#pending.values()) {
      this.#finish(pending, "cancelled", "The dsh-host Turn ended before an answer was received. Do not infer a user choice.");
    }
  }
  dispose() {
    this.stop();
    this.#disposal ??= (async () => {
      await this.#dshCollaboration?.dispose();
      await new Promise((resolve) => {
        this.#server.close(() => resolve());
        this.#server.closeAllConnections();
      });
      if (this.#options.directory === void 0) {
        await rm3(this.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    })();
    return this.#disposal;
  }`,
    'close and clean up Antigravity collaboration relay on Turn completion',
  );

  source = replace(
    source,
    `async function runBuffered(executable, arguments_, cwd, environment, timeoutMs, signal) {
  const invocation = commandInvocation(executable, arguments_, environment);
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd,
      env: environment,`,
    `async function runBuffered(executable, arguments_, cwd, environment, timeoutMs, signal) {
  const cleanEnvironment = dshAntigravityChildEnvironment(environment);
  const invocation = commandInvocation(executable, arguments_, cleanEnvironment);
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd,
      env: cleanEnvironment,`,
    'strip private DSH bridge credentials from auxiliary Antigravity CLI calls',
  );

  source = replace(
    source,
    `    this.#preparingQuestions = previousTurn.then(() => AntigravityQuestionBridge.create({
      ...hookDirectory ? { directory: hookDirectory } : {},
      turnId: command.turnId,`,
    `    this.#preparingQuestions = previousTurn.then(() => AntigravityQuestionBridge.create({
      ...hookDirectory ? { directory: hookDirectory } : {},
      sessionEnvironment: this.#environment,
      turnId: command.turnId,`,
    'pass DSH session environment to Antigravity bridge setup',
  );

  source = replace(
    source,
    '    const environment = { ...this.#environment, ...questions.environment };',
    '    const environment = { ...dshAntigravityChildEnvironment(this.#environment), ...questions.environment };',
    'do not expose private DSH bridge credentials to Antigravity CLI or its shell tools',
  );

  return source;
}

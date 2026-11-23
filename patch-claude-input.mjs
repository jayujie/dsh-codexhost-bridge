export function patchClaudeInput(source, replace) {
  source = replace(source, '  #nativeSteer = false;', '  #nativeSteer = false;\n  #dshRootLifecycle = false;', 'track native root input lifecycle support');
  source = replace(source, '      const initialization = await activeQuery.initializationResult();', '      const initialization = await activeQuery.initializationResult();\n      this.#dshRootLifecycle = dshClaudeRootLifecycle(initialization);', 'learn root lifecycle before the first system init frame');
  source = replace(source, '        accumulator: new ClaudeNativeTurnAccumulator(this.#provider ? { provider: this.#provider } : {}),\n        onEvent,', '        accumulator: new ClaudeNativeTurnAccumulator(this.#provider ? { provider: this.#provider } : {}),\n        dshInputGate: new DshClaudeInputGate(userMessageId, this.#dshRootLifecycle, text2),\n        dshBackground: new ClaudeNativeTurnAccumulator(this.#provider ? { provider: this.#provider } : {}),\n        onEvent,', 'bind the root SDK request to its submitted input UUID');
  source = replace(source, '    accumulator.requestCancel();', '    if (this.#active) this.#active.dshInputGate.cancelRequested = true;\n    accumulator.requestCancel();', 'recognize cancellation before the input starts');
  source = replace(source, '        if (active) {\n          this.#observeRootToolCalls(message);', `        if (active) {
          const admission = active.dshInputGate.inspect(message);
          if (admission === "wait") {
            // Preserve thread-level background occupancy without attributing old
            // model output or terminal receipts to the pending human request.
            if (message.type === "system" && ["background_tasks_changed", "task_started", "task_notification", "task_progress"].includes(message.subtype)) {
              for (const event of active.dshBackground.consume(message).events) {
                if (this.#threadEventHandler && canDeliverSettlementImmediately(event, [])) this.#threadEventHandler(event);
              }
            }
            if (message.type === "result") process.stderr.write("[DSH Claude] ignored terminal before submitted input started; no request replay\\n");
            continue;
          }
          if (admission === "rejected" || admission === "cancelled") {
            this.#closeInteractions("root", "superseded"); this.#rootToolCalls.clear(); this.#active = null;
            active.resolve(admission === "cancelled" ? { status: "cancelled", reason: "cancelled" } : { status: "failed", kind: "inputNotStarted" });
            continue;
          }
          this.#observeRootToolCalls(message);`, 'ignore old receipts until the matching input actually starts');
  source = replace(source, '            active.resolve(interpreted2.terminal);', '            active.resolve(active.dshInputGate.empty(interpreted2.terminal) ? { status: "failed", kind: "emptyResponse" } : interpreted2.terminal);', 'never report a normal empty response as successful completion');
  source = replace(source, '    if (message.type !== "result")\n      return { events };', '    if (message.type !== "result" || nested)\n      return { events };', 'nested SDK results cannot terminate the root request');
  source = replace(source, 'function transportFailure(kind) {', `function transportFailure(kind) {
  if (kind === "emptyResponse" || kind === "inputNotStarted") return {
    code: "protocolError",
    message: kind === "emptyResponse" ? "Claude completed without a response to the submitted input; it was not replayed" : "Claude did not start the submitted input; it was not replayed",
    retryable: false
  };`, 'surface non-retryable input/empty-result failures instead of blank success');
  return source;
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { patchCodexLazyStart } from '../patch-codex-lazy-start.mjs'

test('patchCodexLazyStart transforms raw 0.17.4 runtime anchors cleanly', () => {
  const sample = `
  try {
    await scope.start();
  } catch (error) {
    await scope.close();
    identityReader.close();
    throw error;
  }
  const accounts = new SingleNativeCodexAccount(snapshot, async () => {
    const response = await scope.owner.controlRequest("account/read", { refreshToken: false });
  });
      if (!this.#options.externalOnly) {
        await this.#officialRuntime.initialize();
      }
  request(method, params) {
    return this.#session.request(method, params);
  }
  send(value) {
    if (this.#closed) {
      return Promise.reject(new Error("Official Codex is unavailable"));
    }
    return this.#session.send(value);
  }
  async sendFrame(frame) {
    if (this.#closed) {
      throw new Error("Official Codex is unavailable");
    }
    const value = parseJsonFrame(frame);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Official protocol frame must be an object");
    }
    await this.#session.send(value);
  }
  async #forwardOfficialNonRequest(value, frame) {
    if (this.#options.externalOnly) {
      return;
    }
  }
          result: jsonValueSchema.parse(await this.#codexAccountSnapshot())
`
  const applied = []
  const replace = (text, old, next, label) => {
    assert.equal(text.split(old).length, 2, `anchor must match once: ${label}`)
    applied.push(label)
    return text.replace(old, next)
  }
  const patched = patchCodexLazyStart(sample, replace)
  assert.equal(applied.length, 6)
  assert.ok(patched.includes('async #ensureStarted()'))
  assert.ok(patched.includes('if (scope.gate.phase !== "ready") await scope.start();'))
  assert.ok(patched.includes('this.#options.eagerOfficial'))
})

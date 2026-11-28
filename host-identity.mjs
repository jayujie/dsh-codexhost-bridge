/**
 * Session record names this plugin writes. New records use `plugin:dsh-host/<name>`;
 * sessions recorded before 2026-11-27 carry the legacy prefix, so every reader accepts both.
 * Browser-side modules (native-replies-client.mjs, native-compaction-client.mjs) cannot import
 * this file because build-client.mjs strips imports; they carry literal copies.
 */
export const HOST_RECORD_PREFIX = 'plugin:dsh-host/'
// Read-only compatibility with sessions written before the rename; never written again.
const LEGACY_RECORD_PREFIX = 'plugin:codexhost/'

/** The record type to write for `name`, e.g. `hostRecord('thread')` -> `plugin:dsh-host/thread`. */
export const hostRecord = name => HOST_RECORD_PREFIX + name
/** Every type a reader must accept for `name`: the current one first, then the legacy one. */
export const hostRecordTypes = name => [HOST_RECORD_PREFIX + name, LEGACY_RECORD_PREFIX + name]
/** Whether `type` is the current or legacy record type for `name`. */
export const isHostRecord = (type, name) => type === HOST_RECORD_PREFIX + name || type === LEGACY_RECORD_PREFIX + name

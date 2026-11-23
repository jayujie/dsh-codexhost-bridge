import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { nativeImageInput, resolveWorkspaceImage } from '../native-attachments.mjs'

const image = { type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 8, width: 1, height: 1, name: 'shot.png' } }

test('Codex and Claude image input keep the resolved path and do not drop the caption', () => {
  const file = 'D:\\work\\shot.png'
  assert.deepEqual(nativeImageInput('codex', [file], ['看这张图']), [
    { type: 'text', text: '看这张图' },
    { type: 'localImage', path: file },
  ])
  const claude = nativeImageInput('claude-code', [file], ['看这张图'])
  assert.equal(claude.length, 1)
  assert.match(claude[0].text, /Image attachment: true/)
  assert.match(claude[0].text, /D:\\work\\shot.png/)
  assert.match(claude[0].text, /看这张图/)
})

test('workspace images resolve only to a regular file inside the conversation directory', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-host-image-')))
  const nested = path.join(root, 'nested')
  await mkdir(nested)
  const file = path.join(nested, 'shot.png')
  await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const outside = path.join(path.dirname(root), 'outside.png')
  await writeFile(outside, 'x')
  const link = path.join(nested, 'link.png')
  await symlink(file, link)
  const store = { imageHostPath: () => file }
  assert.equal(await resolveWorkspaceImage(store, root, image), await realpath(file))
  await assert.rejects(resolveWorkspaceImage({ imageHostPath: () => outside }, root, image), /workspace/)
  await assert.rejects(resolveWorkspaceImage({ imageHostPath: () => link }, root, image), /regular file|workspace/)
  await assert.rejects(resolveWorkspaceImage(store, root, { type: 'file', attachment: image.attachment }), /Only saved workspace images/)
  await assert.rejects(resolveWorkspaceImage({}, root, image), /attachment store/)
})

test('DSH attachment store images resolve, while symlinks and foreign paths stay rejected', async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-home-')))
  const objects = path.join(home, 'attachments', 'v1', 'objects', '2e')
  await mkdir(objects, { recursive: true })
  const stored = path.join(objects, '2e2b0484')
  await writeFile(stored, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const link = path.join(objects, 'link.png')
  await symlink(stored, link)
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-ws-')))
  const foreignDir = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-foreign-')))
  const foreign = path.join(foreignDir, 'foreign.png')
  await writeFile(foreign, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.equal(await resolveWorkspaceImage({ imageHostPath: () => stored }, workspace, image), await realpath(stored))
    await assert.rejects(resolveWorkspaceImage({ imageHostPath: () => link }, workspace, image), /regular file/)
    await assert.rejects(resolveWorkspaceImage({ imageHostPath: () => foreign }, workspace, image), /regular file/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

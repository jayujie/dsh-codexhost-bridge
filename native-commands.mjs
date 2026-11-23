import { HostConnectionError } from './native-host-client.mjs'

export const NATIVE_COMMAND_NAMES = Object.freeze(['compact', 'goal'])
export const NATIVE_COMMAND_ENGINES = Object.freeze(['claude-code', 'antigravity'])

/** Only a leading, explicit human command owns this dispatch; quoted/inline text does not. */
export function nativeCommandInput(messages) {
  const users = messages.filter(message => message.source?.kind === 'user')
  const user = users.find(message => message.content?.[0]?.type === 'text' && /^\s*\/(?:compact|goal)(?=\s|$)/u.test(message.content[0].text))
  if (!user) return undefined
  if (users.length !== 1 || user.content.some(block => block.type !== 'text')) throw new HostConnectionError('HOST_COMMAND_INPUT', '原生命令只能单独发送，不支持附件或合并多条用户输入')
  const text = user.content.map(block => block.text).join('\n').trim()
  if (text.length > 65536 || text.includes('\0')) throw new HostConnectionError('HOST_COMMAND_INPUT', '原生命令参数过长或包含无效字符')
  const match = /^\/(compact|goal)(?:\s+([\s\S]*))?$/u.exec(text)
  return { name: match[1], text: match[2] ?? '', message: user }
}

/** Resolve by exact native invocation, never guess a dynamic command id. */
export function nativeCommandDescriptor(catalog, name) {
  const command = catalog?.commands?.find(row => row.invocation === `/${name}`)
  if (!command || typeof command.id !== 'string' || !command.id || !['text', 'none'].includes(command.argumentMode)) throw new HostConnectionError('HOST_COMMAND_UNSUPPORTED', `当前 Claude Host 未提供原生 /${name}；未发送普通提示词`)
  return command
}

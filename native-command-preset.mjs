import { NATIVE_COMMAND_NAMES } from './native-commands.mjs'

export const inject = ['commands']

/** External preset contribution (Claude Code & Antigravity): normal DSH command menu/chips, no client-side interception. */
export function apply(ctx) {
  for (const name of NATIVE_COMMAND_NAMES) ctx.effect(() => ctx.commands.register({
    name,
    description: name === 'compact' ? '原生压缩上下文（可附保留要求）' : '原生目标：查看、设置完成条件或 clear 清除',
    input: { hint: name === 'compact' ? '可选：需要保留的内容' : '完成条件；留空查看；clear 清除' },
    handler({ agent, rawInput, signal }) {
      signal.throwIfAborted()
      const driver = ctx.get('dshHostNative')
      if (!driver?.available()) return { kind: 'error', text: 'Host 命令驱动不可用，未发送任务' }
      return driver.submitCommand(agent, name, rawInput, signal)
    },
  }), `dsh-host: native /${name}`)
}

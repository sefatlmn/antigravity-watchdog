// Watchdog's agents inside a Claude Code session. Audits run as
// background subagents of the session (the plugin's agent types in agents/), on the
// session's own sign-in. Claude starts them at the person's request: `/watchdog audit`
// (or the MCP tool) carries the request alongside the tool's result. Once one starts, it may only do what its task needs: this module
// answers every tool call it makes, allowing its rules and denying the rest, without
// touching the person's own permission settings. The rules match claude_permission_args in
// scripts/watchdog_ctl.py, which applies them to background `claude -p` outside Claude Code.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentGrant } from '../types'

const AUDITOR = 'watchdog:watchdog-auditor'

export const agents = atom({ plugin: 'watchdog', key: 'agents' } as const, {} as Record<string, AgentGrant>)

const ctlPath = ($: EngineInterface) => `${$.plugin.root}/scripts/watchdog_ctl.py`

// Starts waiting for Claude to launch them, keyed by their task file: when an agent starts
// whose prompt names that file, it gets the grant.
export const pending = atom({ plugin: 'watchdog', key: 'pending' } as const, {} as Record<string, AgentGrant>)

// Saves a task where Git ignores it (.antigravity/ is excluded) and returns the short request
// that asks Claude to start it.
async function request($: EngineInterface, type: string, what: string, taskFile: string, task: string, grant: AgentGrant) {
  await $.fs.write(taskFile, task)
  await update($, pending, all => ({ ...all, [taskFile]: grant }))
  return `Watchdog: ${what}. Start one background agent (subagent_type \`${type}\`) with this prompt: "Read your task in ${taskFile} and follow it."`
}

// Runs the controller as the session's own (WATCHDOG_IN_SESSION: it queues, and never
// starts background `claude -p`).
async function ctl($: EngineInterface, args: string[], stdin?: string): Promise<any> {
  const ran = await $.process.run(['python3', ctlPath($), ...args, '--json', '--host', 'claude'], {
    env: { WATCHDOG_IN_SESSION: '1', WATCHDOG_HOST: 'claude' },
    timeoutMs: 60_000,
    stdin,
  })
  try {
    return JSON.parse(ran.stdout || '{}')
  } catch {
    return { ok: false, error: ran.stderr.trim() || `exit ${ran.exitCode}` }
  }
}

// The Git repository `dir` (or the session's folder) is in; '' when it is in none.
export async function repoRoot($: EngineInterface, dir?: string): Promise<string> {
  const cwd = dir ?? (await $.session.cwd())
  const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd }).catch(() => null)
  return ran?.exitCode === 0 ? ran.stdout.trim() : ''
}

// Claims every audit this session queued for the repository (for any repository, when the
// session's folder is in none) and returns the requests that start them. Claiming first
// means two open sessions never both start one.
export async function requestQueuedAudits($: EngineInterface, repo?: string): Promise<string[]> {
  const root = repo ?? (await repoRoot($))
  const claimed = await ctl($, ['claim', ...(root ? ['--repo', root] : [])])
  const requests: string[] = []
  for (const job of claimed.jobs ?? []) {
    const grant: AgentGrant = {
      roots: [String(job.worktree_path), `${job.repo_path}/.antigravity/audits`],
      ctl: claimed.ctl,
      jobId: job.id,
    }
    const taskFile = `${job.repo_path}/.antigravity/tasks/audit-${job.short_sha}.md`
    requests.push(await request($, AUDITOR, `audit commit ${job.short_sha}`, taskFile, String(job.prompt), grant))
  }
  return requests
}

const GIT_READ = ['status', 'diff', 'show', 'log', 'ls-files', 'rev-parse', 'rev-list', 'blame']
const RUNNERS = ['npm run', 'pnpm run', 'pnpm', 'yarn']
const VERBS = ['test', 'lint', 'typecheck', 'build', 'dev', 'preview', 'start']
const CHECKS = [
  ...RUNNERS.flatMap(pm => VERBS.map(verb => `${pm} ${verb}`)),
  'npm test', 'npx tsc', 'npx vitest', 'npx jest', 'npx eslint', 'npx vite', 'node --check',
  'pytest', 'python3 -m pytest', 'python3 -m py_compile', 'python3 -m http.server',
  'cargo check', 'cargo test', 'go vet', 'go test',
]
const LOOK = ['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'echo', 'which', 'sleep']
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'TodoWrite']
const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2')
const isInside = (path: string, roots: string[]) =>
  !/(^|\/)\.\.(\/|$)/.test(path) && roots.some(root => path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`))
const startsWithWord = (s: string, prefix: string) => s === prefix || s.startsWith(`${prefix} `)

function parseShellCommand(command: string): { subcommands: string[]; error: string | null } {
  const input = command.replace(/\\\n/g, ' ')

  const subcommands: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let i = 0

  while (i < input.length) {
    const ch = input[i]

    if (inSingle) {
      if (ch === "'") {
        inSingle = false
      }
      current += ch
      i++
      continue
    }

    if (inDouble) {
      if (ch === '\\' && i + 1 < input.length) {
        current += ch + input[i + 1]
        i += 2
        continue
      }
      if (ch === '"') {
        inDouble = false
      } else if (ch === '$' && i + 1 < input.length && input[i + 1] === '(') {
        return { subcommands: [], error: 'redirects and command substitution are not allowed' }
      }
      current += ch
      i++
      continue
    }

    if (ch === "'") {
      inSingle = true
      current += ch
      i++
      continue
    }

    if (ch === '"') {
      inDouble = true
      current += ch
      i++
      continue
    }

    if (ch === '\\' && i + 1 < input.length) {
      current += ch + input[i + 1]
      i += 2
      continue
    }

    if (ch === '$' && i + 1 < input.length && input[i + 1] === '(') {
      return { subcommands: [], error: 'redirects and command substitution are not allowed' }
    }

    if (ch === '`') {
      return { subcommands: [], error: 'redirects and command substitution are not allowed' }
    }

    const remainder = input.slice(i)
    const allowedRedirect = /^(\d?>&\d|\d?>\s*\/dev\/null)/.exec(remainder)
    if (allowedRedirect) {
      current += ' '
      i += allowedRedirect[0].length
      continue
    }

    if (ch === '<' || ch === '>') {
      return { subcommands: [], error: 'redirects and command substitution are not allowed' }
    }

    if (remainder.startsWith('&&') || remainder.startsWith('||')) {
      subcommands.push(current)
      current = ''
      i += 2
      continue
    }

    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      subcommands.push(current)
      current = ''
      i++
      continue
    }

    current += ch
    i++
  }

  if (inSingle || inDouble) {
    return { subcommands: [], error: 'unclosed quote in command' }
  }

  if (current) {
    subcommands.push(current)
  }

  return { subcommands, error: null }
}

// Whether every part of a shell command is one the grant allows. `cd` moves where `git add`
// and `git commit` would act; those are allowed only inside the grant's first folder.
export function commandAllowed(grant: AgentGrant, command: string): string | null {
  const { subcommands, error } = parseShellCommand(command)
  if (error) return error

  let dir = ''
  for (const raw of subcommands) {
    let part = raw.trim()
    if (!part) continue
    if (startsWithWord(part, 'cd')) {
      dir = unquote(part.slice(2))
      continue
    }
    const gitDir = /^git\s+-C\s+("[^"]*"|'[^']*'|\S+)\s+/.exec(part)
    if (gitDir?.[1]) part = `git ${part.slice(gitDir[0].length)}`
    const at = gitDir?.[1] ? unquote(gitDir[1]) : dir
    if (GIT_READ.some(sub => startsWithWord(part, `git ${sub}`))) continue
    if (startsWithWord(part, 'git add') || startsWithWord(part, 'git commit')) {
      if (at && isInside(at, grant.roots.slice(0, 1))) continue
      return 'git add and git commit are only allowed in the audit worktree'
    }
    if (
      startsWithWord(part, `python3 "${grant.ctl}" complete`) ||
      startsWithWord(part, `python3 '${grant.ctl}' complete`) ||
      startsWithWord(part, `python3 ${grant.ctl} complete`)
    ) continue
    if (CHECKS.some(prefix => startsWithWord(part, prefix))) continue
    if (LOOK.some(prefix => startsWithWord(part, prefix)) && !/\s-(delete|exec|execdir|ok)\b/.test(part)) continue
    return `\`${part.split(/\s+/).slice(0, 3).join(' ')}\` is not one of the commands a Watchdog audit may run`
  }
  return null
}

function decide(grant: AgentGrant, tool: string, input: any): { decision: 'allow' | 'deny'; reason?: string } {
  const deny = (why: string) => ({ decision: 'deny' as const, reason: `Watchdog: ${why}.` })
  if (READ_ONLY_TOOLS.includes(tool)) return { decision: 'allow' }
  if (FILE_TOOLS.includes(tool)) {
    const path = String(input?.file_path ?? input?.notebook_path ?? '')
    return isInside(path, grant.roots) ? { decision: 'allow' } : deny(`an audit may only write in ${grant.roots.join(' and ')}`)
  }
  if (tool === 'Bash') {
    const why = commandAllowed(grant, String(input?.command ?? ''))
    return why ? deny(why) : { decision: 'allow' }
  }
  if (tool.startsWith('mcp__playwright__')) return { decision: 'allow' }
  return deny(`an audit may not use ${tool}`)
}

export const register: Register = on => {
  // When Claude starts a Watchdog agent whose prompt names a waiting task file, the agent
  // gets that task's grant, and an audit is recorded as running.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const spec = e as unknown as { subagentType?: string; subagent_type?: string; prompt?: string }
    const agentId = result.agentId
    if (!agentId || (spec.subagentType ?? spec.subagent_type) !== AUDITOR) return result
    const waiting = await read($, pending)
    const taskFile = Object.keys(waiting).find(file => String(spec.prompt ?? '').includes(file))
    const grant = taskFile ? waiting[taskFile] : undefined
    if (!taskFile || !grant) return result
    await update($, pending, all => Object.fromEntries(Object.entries(all).filter(([file]) => file !== taskFile)))
    await update($, agents, all => ({ ...all, [agentId]: grant }))
    await ctl($, ['mark-running', '--job-id', grant.jobId, '--conversation-id', `claude-agent-${agentId}`])
    return result
  }).catch(($, e, next) => next(e))

  // Every tool call a Watchdog agent makes is decided here; everyone else's goes on as usual.
  on('tool.check', async ($, e, next) => {
    const grant = e.agentId ? (await read($, agents))[e.agentId] : undefined
    return grant ? decide(grant, e.tool, e.input) : next(e)
  }).catch(($, e, next) =>
    // Failing closed for subagents: a Watchdog agent's call must never fall through to wider rules.
    next.called || !e.agentId ? next(e) : { decision: 'deny' as const, reason: 'Watchdog could not check this call.' },
  )

  // An audit agent that ends without reporting is marked interrupted at once, so the
  // panel offers Continue Audit instead of waiting out the timeout.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const grant = e.agentId ? (await read($, agents))[e.agentId] : undefined
    if (e.agentId && grant) {
      const agentId = e.agentId
      await ctl($, ['agent-done', '--conversation-id', `claude-agent-${agentId}`])
      await update($, agents, all => Object.fromEntries(Object.entries(all).filter(([id]) => id !== agentId)))
    }
    return result
  })

  // `/watchdog audit`, `/watchdog continue` and the MCP tools queue an audit; the request
  // that starts it goes to Claude with the tool's result, in the turn the person asked in.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!/__watchdog_(audit|continue)$/.test(e.tool) || 'deny' in result) return result
    const asked = (e as unknown as { repo?: unknown }).repo
    const requests = await requestQueuedAudits($, typeof asked === 'string' && asked ? await repoRoot($, asked) : undefined)
    return requests.length > 0 ? { ...result, context: [...(result.context ?? []), ...requests] } : result
  }).catch(($, e, next) => next(e))
}

import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'

/** Stable publication audit identifiers suitable for CI diagnostics. */
export type PublicationIssueCode =
  | 'credential-content'
  | 'durable-state'
  | 'environment-file'
  | 'outside-root'
  | 'private-persona'
  | 'session-log'

/** One file that makes the repository unsafe to publish. */
export interface PublicationIssue {
  /** Machine-readable reason. */
  code: PublicationIssueCode
  /** Repository-relative path supplied to the audit. */
  path: string
  /** Human-readable remediation. */
  message: string
}

/** Inputs for auditing the exact file set Git or a package would publish. */
export interface AuditPublicationOptions {
  /** Absolute or process-relative repository root. */
  root: string
  /** Repository-relative files to inspect. */
  files: readonly string[]
}

const DURABLE_STATE_EXTENSION = /\.(?:db|sqlite|sqlite3)$/i
const SESSION_LOG_EXTENSION = /\.jsonl$/i
const TEXT_CONFIG_EXTENSION = /\.(?:env|ini|json|toml|ya?ml)$/i
const CREDENTIAL_ASSIGNMENT = /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*["']?([^\s"']+)/i
const SAFE_CREDENTIAL_VALUE = /^(?:\$\{|<|example\b|placeholder\b|changeme\b|your[-_])/i

function portablePath(path: string): string {
  return path.replaceAll('\\', '/')
}

function personaPathIsPrivate(path: string): boolean {
  const segments = portablePath(path).split('/')
  const index = segments.lastIndexOf('personas')
  if (index < 0) return false
  const collection = segments[index + 1]
  return collection !== 'template' && collection !== 'example'
}

function environmentFileIsPrivate(path: string): boolean {
  const file = basename(path)
  return file === '.env' || (file.startsWith('.env.') && file !== '.env.example')
}

function pathIssue(path: string): PublicationIssue | undefined {
  if (personaPathIsPrivate(path)) {
    return { code: 'private-persona', path, message: 'Only personas/template and personas/example may be published.' }
  }
  if (DURABLE_STATE_EXTENSION.test(path)) {
    return { code: 'durable-state', path, message: 'Database and durable state files belong in the private data directory.' }
  }
  if (SESSION_LOG_EXTENSION.test(path)) {
    return { code: 'session-log', path, message: 'Session logs must not be committed or packaged.' }
  }
  if (environmentFileIsPrivate(path)) {
    return { code: 'environment-file', path, message: 'Environment files are private; publish only .env.example.' }
  }
  return undefined
}

async function credentialIssue(root: string, path: string): Promise<PublicationIssue | undefined> {
  if (!TEXT_CONFIG_EXTENSION.test(path)) return undefined
  const content = await readFile(resolve(root, path), 'utf8')
  const match = CREDENTIAL_ASSIGNMENT.exec(content)
  const value = match?.[1]
  if (value === undefined || SAFE_CREDENTIAL_VALUE.test(value)) return undefined
  return { code: 'credential-content', path, message: 'Configuration contains a non-placeholder credential value.' }
}

/**
 * Audit files intended for Git or package publication.
 * @param options - Repository root and the exact candidate file set.
 * @returns Findings in the same order as the supplied files.
 */
export async function auditPublication(options: AuditPublicationOptions): Promise<PublicationIssue[]> {
  const root = resolve(options.root)
  const issues: PublicationIssue[] = []
  for (const suppliedPath of options.files) {
    const path = portablePath(suppliedPath)
    const absolute = resolve(root, path)
    const fromRoot = portablePath(relative(root, absolute))
    if (isAbsolute(suppliedPath) || fromRoot === '..' || fromRoot.startsWith('../')) {
      issues.push({ code: 'outside-root', path, message: 'Publication inputs must stay inside the repository root.' })
      continue
    }
    const issue = pathIssue(path) ?? await credentialIssue(root, path)
    if (issue !== undefined) issues.push(issue)
  }
  return issues
}

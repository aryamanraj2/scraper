import { redact } from './redact.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogRecord = {
  level: LogLevel
  msg: string
  at: string
  [key: string]: unknown
}

export type LogSink = (record: LogRecord) => void

/**
 * Structured logger. Every field, including the message, passes through `redact`
 * on the way to the sink — so a credential cannot reach a log line by being
 * passed to a call site that forgot about it.
 */
export class Logger {
  constructor(
    private readonly sink: LogSink = defaultSink,
    private readonly base: Record<string, unknown> = {},
  ) {}

  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.sink, { ...this.base, ...fields })
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    const merged = { ...this.base, ...fields }
    const safe = redact(merged) as Record<string, unknown>
    this.sink({
      ...safe,
      level,
      msg: redact(msg) as string,
      at: new Date().toISOString(),
    })
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.write('debug', msg, fields) }
  info(msg: string, fields?: Record<string, unknown>): void { this.write('info', msg, fields) }
  warn(msg: string, fields?: Record<string, unknown>): void { this.write('warn', msg, fields) }
  error(msg: string, fields?: Record<string, unknown>): void { this.write('error', msg, fields) }
}

function defaultSink(record: LogRecord): void {
  const line = JSON.stringify(record)
  if (record.level === 'error' || record.level === 'warn') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

export const logger = new Logger()

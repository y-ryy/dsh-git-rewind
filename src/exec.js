/**
 * Bounded child-process execution for Git.
 *
 * Every command is an argv array: no shell string is ever built. Stdout and
 * stderr are collected up to a byte cap; a command that exceeds it is killed
 * and reported as truncated instead of growing the Host heap without bound.
 */
import { spawn } from 'node:child_process'

export class ProcessError extends Error {
  constructor(message, code = 'process-failed') {
    super(message)
    this.name = 'ProcessError'
    this.code = code
  }
}

/**
 * @param {string[]} argv
 * @param {{cwd?: string, env?: Record<string,string>, timeoutMs?: number, maxBytes?: number, signal?: AbortSignal}} options
 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean, cancelled: boolean}>}
 */
export function runProcess(argv, options = {}) {
  const {
    cwd = process.cwd(),
    env = {},
    timeoutMs = 15000,
    maxBytes = 2 * 1024 * 1024,
    signal,
  } = options

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }

    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false
    let cancelled = false
    let settled = false

    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        truncated,
        cancelled,
      })
    }

    const kill = () => {
      try { child.kill() } catch { /* already gone */ }
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, Math.max(1000, timeoutMs))

    const onAbort = () => {
      cancelled = true
      kill()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes >= maxBytes) {
        truncated = true
        kill()
        return
      }
      const remaining = maxBytes - stdoutBytes
      stdout.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
      stdoutBytes += Math.min(chunk.length, remaining)
      if (chunk.length > remaining) {
        truncated = true
        kill()
      }
    })
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= maxBytes) return
      const remaining = maxBytes - stderrBytes
      stderr.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
      stderrBytes += Math.min(chunk.length, remaining)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => finish(code))
  })
}

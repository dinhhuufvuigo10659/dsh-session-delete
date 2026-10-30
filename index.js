/**
 * Host half of @local/dsh-session-delete.
 *
 * DSH ships archive/unarchive but no delete API, so permanent deletion runs
 * here: stop activity → detach the live Session → remove the durable log →
 * clean the workspace ledger → tell the client the Session is gone. The
 * browser half calls this through the plugin's own loopback route.
 *
 * Route: POST /dsh-session-delete/delete  { "sessionId": "session-..." }
 *        GET  /dsh-session-delete/health
 *
 * Safety:
 * - loopback Host only, same-origin only, never cross-site;
 * - delegates to `connection.requestRejection` when the composition has it;
 * - a running turn is cancelled and awaited before the runtime is detached, so
 *   no flush can write the directory back after deletion;
 * - the directory is verified (`basename === sessionId`) and re-checked after
 *   removal before success is reported;
 * - an id that is not a plain Session id is refused, so no path can escape the
 *   sessions root.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROUTE_PREFIX = '/dsh-session-delete'
const MAX_BODY_BYTES = 4096
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
/** Upper bound for the subagent transcripts removed together with one Session. */
const MAX_DESCENDANTS = 200

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function optional(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** Root of this DSH home, e.g. `C:\Users\me\.dsh`. */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv || path.join(os.homedir(), '.dsh')
}

function projectionCheckpoint(id) {
  return path.join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`)
}

async function pathExists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

function isLoopbackHostname(name) {
  const host = String(name || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!parts) return false
  if (Number(parts[1]) !== 127) return false
  return [parts[2], parts[3], parts[4]].every((part) => Number(part) <= 255)
}

/**
 * Trust fence for a destructive local route: anything that is not a
 * same-origin request from this machine is refused, and the Host's own
 * admission check is consulted when it exists.
 */
function rejectionFor(ctx, req) {
  const headers = (req && req.headers) || {}
  let authority
  try {
    authority = new URL(`http://${String(headers.host || '')}`)
  } catch {
    return 403
  }
  if (!isLoopbackHostname(authority.hostname)) return 403
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin && origin !== 'null') {
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      return 403
    }
    if (originUrl.host.toLowerCase() !== authority.host.toLowerCase()) return 403
  }
  const connection = optional(ctx, 'connection')
  if (connection && typeof connection.requestRejection === 'function') {
    let code
    try {
      code = connection.requestRejection(req)
    } catch {
      return 403
    }
    if (code !== undefined && code !== null && code !== false) {
      return typeof code === 'number' ? code : 403
    }
  }
  return null
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  } catch {
    // The peer is gone; nothing left to do.
  }
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be an object')
  }
  return parsed
}

/** Header of a Session that is not live in this process. */
async function coldHeader(ctx, id) {
  const query = optional(ctx, 'sessionQuery')
  if (!query || typeof query.listSessions !== 'function') return undefined
  try {
    const records = await query.listSessions()
    for (const record of records || []) {
      if (record && record.header && record.header.id === id) return record.header
    }
  } catch {
    // An unreadable corpus means "not found" for our purpose.
  }
  return undefined
}

/**
 * Cancel a running turn and wait for it to settle: detaching mid-turn would
 * leave a half-written log behind.
 */
async function stopActivity(ctx, id, live) {
  if (!live) return
  const agents = optional(ctx, 'agents')
  if (!agents || typeof agents.get !== 'function') return
  if (agents.get(id)?.status !== 'running') return
  const controller = optional(ctx, 'sessionController')
  try {
    void Promise.resolve(controller?.cancel?.({ sessionId: id })).catch(() => {})
  } catch {
    // Detaching next also stops further writes.
  }
  for (let tick = 0; tick < 30; tick += 1) {
    if (agents.get(id)?.status !== 'running') return
    await sleep(100)
  }
}

/**
 * Detach the Session from the runtime. `session/disposed` turns into
 * `api-session/removed`, so the client row goes away immediately; it also
 * closes the write handle so the deleted directory cannot be recreated.
 */
function detachLive(ctx, live) {
  if (!live) return
  const sessions = optional(ctx, 'sessions')
  if (!sessions) return
  if (typeof sessions.liveEntryFor !== 'function' || typeof sessions.detachEntered !== 'function') return
  try {
    sessions.detachEntered(sessions.liveEntryFor(live))
  } catch {
    // Best effort: the directory verification below still reports the truth.
  }
}

/** Directory candidates for one Session: persistence locator, then a scan. */
async function transcriptDirectory(ctx, header) {
  const persistence = optional(ctx, 'sessionPersistence')
  if (persistence && typeof persistence.locate === 'function') {
    try {
      const located = persistence.locate({ id: header.id, cwd: header.cwd })
      if (located && typeof located.path === 'string' && located.path !== '') {
        return path.dirname(located.path)
      }
    } catch {
      // Fall through to the scan.
    }
  }
  const root =
    persistence && typeof persistence.root === 'string' && persistence.root !== ''
      ? persistence.root
      : path.join(dshHome(), 'sessions')
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (path.basename(entry.name) !== entry.name) continue
    const candidate = path.join(root, entry.name, header.id)
    if (await pathExists(candidate)) return candidate
  }
  return undefined
}

/** Remove one Session's log directory and verify it stays gone. */
async function removeTranscript(ctx, header) {
  const directory = await transcriptDirectory(ctx, header)
  if (directory === undefined || path.basename(directory) !== header.id) {
    return { ok: false, code: 'path-unverified', message: `no verified directory for session "${header.id}"` }
  }
  try {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 })
  } catch (error) {
    return { ok: false, code: 'remove-failed', message: String((error && error.message) || error) }
  }
  for (let tick = 0; tick < 3; tick += 1) {
    if (!(await pathExists(directory))) return { ok: true, directory }
    await sleep(150)
  }
  return { ok: false, code: 'remove-failed', message: `directory "${directory}" came back after removal` }
}

/** Clear the archived/pinned leftovers; both calls are no-ops for other ids. */
async function forget(ctx, id) {
  const registry = optional(ctx, 'workspaceRegistry')
  if (!registry) return
  for (const method of ['unarchiveSession', 'unpinSession']) {
    try {
      await registry[method]?.(id)
    } catch {
      // A failed ledger cleanup does not affect the already deleted log.
    }
  }
}

/** Every persisted Session whose parent chain leads to `rootId` (breadth first). */
async function descendantsOf(ctx, rootId) {
  const query = optional(ctx, 'sessionQuery')
  if (!query || typeof query.listSessions !== 'function') return []
  let records
  try {
    records = await query.listSessions()
  } catch {
    return []
  }
  const childrenByParent = new Map()
  for (const record of records || []) {
    const header = record && record.header
    if (!header || !header.parentSession) continue
    const list = childrenByParent.get(header.parentSession) || []
    list.push(header.id)
    childrenByParent.set(header.parentSession, list)
  }
  const found = []
  const queue = [rootId]
  while (queue.length > 0 && found.length < MAX_DESCENDANTS) {
    const current = queue.shift()
    for (const child of childrenByParent.get(current) || []) {
      if (found.includes(child)) continue
      found.push(child)
      queue.push(child)
      if (found.length >= MAX_DESCENDANTS) break
    }
  }
  return found
}

/**
 * Permanently delete one Session (and its subagent transcripts).
 * @returns {Promise<{status: number, body: object}>} the HTTP answer.
 */
async function deleteSession(ctx, rawId) {
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (!SESSION_ID_PATTERN.test(id)) {
    return { status: 400, body: { ok: false, code: 'invalid-id', sessionId: id } }
  }

  const sessions = optional(ctx, 'sessions')
  const live = sessions && typeof sessions.get === 'function' ? sessions.get(id) : undefined
  const header = (live && live.header) || (await coldHeader(ctx, id))
  if (header === undefined && live === undefined) {
    // Already gone: a stale sidebar row is the only reason to be here.
    await forget(ctx, id)
    return { status: 200, body: { ok: true, sessionId: id, removed: 0 } }
  }

  const targets = [id, ...(await descendantsOf(ctx, id))]
  let removed = 0
  let firstFailure = null

  for (const target of targets) {
    const targetSessions = optional(ctx, 'sessions')
    const targetLive = targetSessions && typeof targetSessions.get === 'function' ? targetSessions.get(target) : undefined
    const targetHeader = (targetLive && targetLive.header) || (await coldHeader(ctx, target))
    if (targetHeader === undefined && targetLive === undefined) {
      await forget(ctx, target)
      try {
        await fs.rm(projectionCheckpoint(target), { force: true })
      } catch {
        // Best effort.
      }
      continue
    }
    await stopActivity(ctx, target, targetLive)
    detachLive(ctx, targetLive)
    const outcome = await removeTranscript(ctx, targetHeader)
    if (!outcome.ok) {
      if (firstFailure === null) firstFailure = { sessionId: target, code: outcome.code, message: outcome.message }
      if (target === id) return { status: 500, body: { ok: false, code: outcome.code, sessionId: id, message: outcome.message } }
      continue
    }
    removed += 1
    await forget(ctx, target)
    try {
      await fs.rm(projectionCheckpoint(target), { force: true })
    } catch {
      // Best effort.
    }
    try {
      ctx.emit('api-session/removed', target)
    } catch {
      // A failed notification does not change the delete result.
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      sessionId: id,
      removed,
      ...(firstFailure === null ? {} : { partial: firstFailure }),
    },
  }
}

function createHandler(ctx) {
  return async function handleSessionDelete(req, res) {
    const rejected = rejectionFor(ctx, req)
    if (rejected !== null) {
      sendJson(res, rejected, { ok: false, code: 'forbidden' })
      return
    }

    let pathname
    try {
      pathname = new URL(String(req.url || '/'), 'http://localhost').pathname
    } catch {
      sendJson(res, 400, { ok: false, code: 'bad-request' })
      return
    }

    if (pathname === `${ROUTE_PREFIX}/health`) {
      sendJson(res, 200, { ok: true, plugin: '@local/dsh-session-delete', version: 2 })
      return
    }

    if (pathname !== `${ROUTE_PREFIX}/delete`) {
      sendJson(res, 404, { ok: false, code: 'not-found' })
      return
    }

    if (String(req.method || 'GET').toUpperCase() !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { ok: false, code: 'bad-request' })
      return
    }

    const result = await deleteSession(ctx, body.sessionId)
    sendJson(res, result.status, result.body)
  }
}

/**
 * Cordis plugin body: wait for the HTTP carrier, then own one prefix route for
 * as long as the plugin is loaded.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (scoped) => {
    const handler = createHandler(scoped)
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'session-delete route',
    )
  })
}

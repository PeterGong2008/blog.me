import type { IncomingMessage, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { URL } from 'node:url'

type ConnectMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

interface AdminViteServer {
  middlewares: {
    use: (fn: ConnectMiddleware) => void
    stack?: {
      unshift: (item: { route: string, handle: ConnectMiddleware }) => number
    }
  }
}

interface AdminVitePlugin {
  name: string
  enforce: 'post'
  configureServer: (server: AdminViteServer) => () => void
  configurePreviewServer: (server: AdminViteServer) => () => void
}

interface SafePathInfo {
  rel: string
  abs: string
  kind: 'post' | 'about'
}

interface LocalFileEntry {
  path: string
  kind: 'post' | 'about'
  mtimeMs: number
  head: string
}

const API_PREFIX = '/__admin_api/'
const MAX_TEXT_BODY_BYTES = 5 * 1024 * 1024
const MAX_UPLOAD_JSON_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const ALLOWED_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
}

function getRoots() {
  const cwd = process.cwd()
  return {
    cwd,
    postsRoot: path.resolve(cwd, 'src/content/posts'),
    aboutRoot: path.resolve(cwd, 'src/content/about'),
    imagesRoot: path.resolve(cwd, 'src/content/posts/_images'),
  }
}

function isInsideDir(targetAbs: string, dirAbs: string): boolean {
  const normTarget = process.platform === 'win32' ? targetAbs.toLowerCase() : targetAbs
  const normDir = process.platform === 'win32' ? dirAbs.toLowerCase() : dirAbs
  const prefix = normDir.endsWith(path.sep) ? normDir : `${normDir}${path.sep}`
  return normTarget.startsWith(prefix)
}

function resolveSafeContentPath(rawInput: string, allowAbout = false): SafePathInfo {
  if (!rawInput || rawInput.includes('\0')) {
    throw new Error('Invalid file path')
  }

  const normalized = rawInput.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = normalized.split('/')
  if (segments.some(seg => seg === '' || seg === '.' || seg === '..')) {
    throw new Error('Invalid path segments')
  }

  const { cwd, postsRoot, aboutRoot } = getRoots()
  const abs = path.resolve(cwd, normalized)

  if (normalized.startsWith('src/content/posts/') && isInsideDir(abs, postsRoot)) {
    return { rel: normalized, abs, kind: 'post' }
  }

  if (allowAbout && normalized.startsWith('src/content/about/') && isInsideDir(abs, aboutRoot)) {
    return { rel: normalized, abs, kind: 'about' }
  }

  throw new Error('Path is outside allowed content directories')
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  const body = JSON.stringify(data)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

function sendError(res: ServerResponse, statusCode: number, message: string) {
  sendJson(res, statusCode, { ok: false, error: message })
}

async function readJsonBody<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0

    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      total += buf.length
      if (total > maxBytes) {
        reject(new Error('Request payload too large'))
        req.destroy()
        return
      }
      chunks.push(buf)
    })

    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(JSON.parse(text) as T)
      }
      catch {
        reject(new Error('Invalid JSON payload'))
      }
    })

    req.on('error', err => reject(err))
  })
}

async function scanMarkdownFiles(
  dirAbs: string,
  kind: 'post' | 'about',
  cwd: string,
  out: LocalFileEntry[],
) {
  let entries
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true })
  }
  catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dirAbs, entry.name)
    if (entry.isDirectory()) {
      if (kind === 'post' && entry.name === '_images') {
        continue
      }
      await scanMarkdownFiles(fullPath, kind, cwd, out)
      continue
    }

    if (!entry.isFile() || !/\.(?:md|mdx)$/i.test(entry.name)) {
      continue
    }

    const [stat, content] = await Promise.all([
      fs.stat(fullPath),
      fs.readFile(fullPath, 'utf8'),
    ])

    out.push({
      path: path.relative(cwd, fullPath).replace(/\\/g, '/'),
      kind,
      mtimeMs: stat.mtimeMs,
      head: content.slice(0, 2000),
    })
  }
}

function sanitizeImageFilename(rawName: string): { stem: string, ext: string } {
  const baseName = path.basename(rawName.trim() || 'image.png')
  const rawExt = path.extname(baseName).toLowerCase()
  const ext = rawExt in ALLOWED_IMAGE_MIME ? rawExt : ''
  if (!ext) {
    throw new Error('Unsupported image format')
  }

  const rawStem = baseName.slice(0, baseName.length - rawExt.length)
  const cleanStem = rawStem
    .replace(/[^\w\u4E00-\u9FA5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)

  return {
    stem: cleanStem || `img-${Date.now()}`,
    ext,
  }
}

async function findUniqueImagePath(imagesRoot: string, stem: string, ext: string): Promise<string> {
  let candidate = path.join(imagesRoot, `${stem}${ext}`)
  let counter = 1
  while (true) {
    try {
      await fs.access(candidate)
      candidate = path.join(imagesRoot, `${stem}-${counter}${ext}`)
      counter += 1
    }
    catch {
      return candidate
    }
  }
}

function computeRelativePosix(fromPostRel: string | undefined, targetRel: string): string {
  if (!fromPostRel) {
    return `./_images/${path.posix.basename(targetRel)}`
  }
  const fromDir = path.posix.dirname(fromPostRel.replace(/\\/g, '/'))
  let rel = path.posix.relative(fromDir, targetRel.replace(/\\/g, '/'))
  if (!rel.startsWith('.')) {
    rel = `./${rel}`
  }
  return rel
}

interface MediaEntry {
  repoPath: string
  filename: string
  size: number
  mtimeMs: number
  previewUrl: string
}

async function scanMediaFiles(
  dirAbs: string,
  cwd: string,
  out: MediaEntry[],
) {
  let entries
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true })
  }
  catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dirAbs, entry.name)
    if (entry.isDirectory()) {
      await scanMediaFiles(fullPath, cwd, out)
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    const ext = path.extname(entry.name).toLowerCase()
    if (!(ext in ALLOWED_IMAGE_MIME)) {
      continue
    }
    const stat = await fs.stat(fullPath)
    const repoPath = path.relative(cwd, fullPath).replace(/\\/g, '/')
    out.push({
      repoPath,
      filename: entry.name,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      previewUrl: `${API_PREFIX}media?path=${encodeURIComponent(repoPath)}`,
    })
  }
}

async function handleApiRequest(req: IncomingMessage, res: ServerResponse) {
  const method = (req.method || 'GET').toUpperCase()
  const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1')
  const endpoint = parsedUrl.pathname.slice(API_PREFIX.length)

  if (method === 'GET' && endpoint === 'status') {
    sendJson(res, 200, { ok: true, mode: 'local', features: { format: true } })
    return
  }

  if (method === 'GET' && endpoint === 'files') {
    const { cwd, postsRoot, aboutRoot } = getRoots()
    const files: LocalFileEntry[] = []
    await Promise.all([
      scanMarkdownFiles(postsRoot, 'post', cwd, files),
      scanMarkdownFiles(aboutRoot, 'about', cwd, files),
    ])
    sendJson(res, 200, { ok: true, files })
    return
  }

  if (method === 'GET' && endpoint === 'file') {
    const rawPath = parsedUrl.searchParams.get('path') || ''
    const info = resolveSafeContentPath(rawPath, true)
    if (!/\.(?:md|mdx)$/i.test(info.abs)) {
      sendError(res, 400, 'Only Markdown files can be read')
      return
    }
    const [stat, content] = await Promise.all([
      fs.stat(info.abs),
      fs.readFile(info.abs, 'utf8'),
    ])
    sendJson(res, 200, { ok: true, path: info.rel, content, mtimeMs: stat.mtimeMs })
    return
  }

  if (method === 'PUT' && endpoint === 'file') {
    const body = await readJsonBody<{ path?: string, content?: string, oldPath?: string }>(req, MAX_TEXT_BODY_BYTES)
    if (typeof body.path !== 'string' || typeof body.content !== 'string') {
      sendError(res, 400, 'Missing path or content')
      return
    }

    const info = resolveSafeContentPath(body.path, true)
    if (!/\.(?:md|mdx)$/i.test(info.abs)) {
      sendError(res, 400, 'Only .md or .mdx files are allowed')
      return
    }

    await fs.mkdir(path.dirname(info.abs), { recursive: true })
    await fs.writeFile(info.abs, body.content, 'utf8')
    const stat = await fs.stat(info.abs)

    if (body.oldPath && body.oldPath !== info.rel) {
      const oldInfo = resolveSafeContentPath(body.oldPath, false)
      if (oldInfo.kind === 'post' && oldInfo.abs !== info.abs) {
        await fs.unlink(oldInfo.abs).catch(() => {})
      }
    }

    sendJson(res, 200, { ok: true, path: info.rel, mtimeMs: stat.mtimeMs })
    return
  }

  if (method === 'DELETE' && endpoint === 'file') {
    const rawPath = parsedUrl.searchParams.get('path') || ''
    const info = resolveSafeContentPath(rawPath, false)
    if (!/\.(?:md|mdx)$/i.test(info.abs)) {
      sendError(res, 400, 'Only post Markdown files can be deleted')
      return
    }
    await fs.unlink(info.abs)
    sendJson(res, 200, { ok: true })
    return
  }

  if (method === 'POST' && endpoint === 'upload') {
    const body = await readJsonBody<{ filename?: string, dataBase64?: string, postPath?: string }>(req, MAX_UPLOAD_JSON_BYTES)
    if (typeof body.filename !== 'string' || typeof body.dataBase64 !== 'string') {
      sendError(res, 400, 'Missing filename or image data')
      return
    }

    const { stem, ext } = sanitizeImageFilename(body.filename)
    const buffer = Buffer.from(body.dataBase64, 'base64')
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
      sendError(res, 400, 'Image size must be between 1B and 10MB')
      return
    }

    const { cwd, imagesRoot } = getRoots()
    await fs.mkdir(imagesRoot, { recursive: true })
    const targetAbs = await findUniqueImagePath(imagesRoot, stem, ext)
    await fs.writeFile(targetAbs, buffer)

    const repoPath = path.relative(cwd, targetAbs).replace(/\\/g, '/')
    let validPostPath: string | undefined
    if (body.postPath) {
      try {
        validPostPath = resolveSafeContentPath(body.postPath, false).rel
      }
      catch {
        validPostPath = undefined
      }
    }

    sendJson(res, 200, {
      ok: true,
      repoPath,
      markdownPath: computeRelativePosix(validPostPath, repoPath),
      previewUrl: `${API_PREFIX}media?path=${encodeURIComponent(repoPath)}`,
    })
    return
  }

  if (method === 'GET' && endpoint === 'media-list') {
    const { cwd, imagesRoot } = getRoots()
    const items: MediaEntry[] = []
    await scanMediaFiles(imagesRoot, cwd, items)
    items.sort((a, b) => b.mtimeMs - a.mtimeMs)
    sendJson(res, 200, { ok: true, items })
    return
  }

  if (method === 'GET' && endpoint === 'media') {
    const rawPath = parsedUrl.searchParams.get('path') || ''
    const info = resolveSafeContentPath(rawPath, false)
    const ext = path.extname(info.abs).toLowerCase()
    const mime = ALLOWED_IMAGE_MIME[ext]
    if (!mime) {
      sendError(res, 400, 'Unsupported media type')
      return
    }
    const data = await fs.readFile(info.abs)
    res.statusCode = 200
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'no-store')
    res.end(data)
    return
  }

  if (method === 'DELETE' && endpoint === 'media') {
    const rawPath = parsedUrl.searchParams.get('path') || ''
    const { imagesRoot } = getRoots()
    const info = resolveSafeContentPath(rawPath, false)
    const ext = path.extname(info.abs).toLowerCase()
    if (!isInsideDir(info.abs, imagesRoot) || !(ext in ALLOWED_IMAGE_MIME)) {
      sendError(res, 400, 'Only image files under src/content/posts/_images/ can be deleted')
      return
    }
    await fs.unlink(info.abs)
    sendJson(res, 200, { ok: true })
    return
  }

  if (method === 'POST' && endpoint === 'format') {
    const body = await readJsonBody<{ body?: string }>(req, MAX_TEXT_BODY_BYTES)
    if (typeof body.body !== 'string') {
      sendError(res, 400, 'Missing body text')
      return
    }
    const { format } = await import('autocorrect-node')
    sendJson(res, 200, { ok: true, body: format(body.body) })
    return
  }

  sendError(res, 404, 'Admin API endpoint not found')
}

function createAdminRedirectMiddleware(basePath: string) {
  const cleanBase = basePath === '/' ? '' : basePath.replace(/\/$/, '')
  const bareAdmin = `${cleanBase}/admin`

  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url) {
      next()
      return
    }
    const parsedUrl = new URL(req.url, 'http://127.0.0.1')
    if (parsedUrl.pathname === bareAdmin) {
      res.statusCode = 302
      res.setHeader('Location', `${bareAdmin}/${parsedUrl.search}`)
      res.end()
      return
    }
    next()
  }
}

export function viteAdminApiPlugin(basePath = '/'): AdminVitePlugin {
  const redirectMiddleware = createAdminRedirectMiddleware(basePath)

  const mountRedirectFirst = (server: AdminViteServer) => () => {
    if (typeof server.middlewares.stack?.unshift === 'function') {
      server.middlewares.stack.unshift({ route: '', handle: redirectMiddleware })
    }
    else {
      server.middlewares.use(redirectMiddleware)
    }
  }

  return {
    name: 'vite-admin-api',
    enforce: 'post',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith(API_PREFIX)) {
          next()
          return
        }

        void handleApiRequest(req, res).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Internal admin API error'
          const status = message.includes('ENOENT') ? 404 : message.includes('outside') || message.includes('Invalid') ? 400 : 500
          if (!res.headersSent) {
            sendError(res, status, message)
          }
        })
      })

      return mountRedirectFirst(server)
    },
    configurePreviewServer(server) {
      return mountRedirectFirst(server)
    },
  }
}

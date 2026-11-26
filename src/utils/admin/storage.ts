import type { ContentKind, PostMeta } from './frontmatter'
import { computeRelativeImagePath, parseMarkdownFile, resolveRepoPathFromRelative } from './frontmatter'

export interface AdminFileSummary {
  path: string
  kind: ContentKind
  meta: PostMeta
  sha?: string
  mtimeMs?: number
}

export interface AdminFileData {
  path: string
  kind: ContentKind
  content: string
  meta: PostMeta
  body: string
  sha?: string
  mtimeMs?: number
}

export interface ImageUploadResult {
  repoPath: string
  markdownPath: string
  previewUrl: string
  hash?: string
  deduplicated?: boolean
  duplicateOf?: string
  pending?: boolean
}

export interface AdminMediaItem {
  repoPath: string
  filename: string
  size: number
  mtimeMs?: number
  previewUrl: string
  hash?: string
  pending?: boolean
}

export interface AdminDocContent {
  path: string
  kind: ContentKind
  title: string
  content: string
}

export interface GitHubConfig {
  owner: string
  repo: string
  branch: string
  token: string
}

export interface StorageAdapter {
  mode: 'local' | 'github'
  listFiles: () => Promise<AdminFileSummary[]>
  readFile: (path: string) => Promise<AdminFileData>
  saveFile: (
    path: string,
    content: string,
    opts?: { oldPath?: string, commitMessage?: string },
  ) => Promise<{ path: string, sha?: string, mtimeMs?: number }>
  deleteFile: (path: string, opts?: { commitMessage?: string }) => Promise<void>
  uploadImage: (file: File, postPath: string) => Promise<ImageUploadResult>
  listMedia: () => Promise<AdminMediaItem[]>
  deleteMedia: (repoPath: string) => Promise<void>
  deleteMediaBatch?: (repoPaths: string[]) => Promise<void>
  commitPendingUploads?: () => Promise<number>
  listDocumentContents?: () => Promise<AdminDocContent[]>
  resolveImagePreviewUrl: (src: string, postPath: string) => Promise<string | null>
  formatBody?: (body: string) => Promise<string>
  getPendingUploadCount?: () => number
  clearPendingUploads?: () => void
  getActionsUrl?: () => string | null
}

const GITHUB_STORAGE_KEY = 'retypeset-admin-github-config'
const IMAGE_MAX_DIMENSION = 2400
const IMAGE_SKIP_SIZE_BYTES = 1.2 * 1024 * 1024

export function loadGitHubConfig(): GitHubConfig {
  try {
    const raw = localStorage.getItem(GITHUB_STORAGE_KEY)
    if (!raw) {
      return { owner: '', repo: '', branch: 'main', token: '' }
    }
    const parsed = JSON.parse(raw) as Partial<GitHubConfig>
    return {
      owner: typeof parsed.owner === 'string' ? parsed.owner : '',
      repo: typeof parsed.repo === 'string' ? parsed.repo : '',
      branch: typeof parsed.branch === 'string' && parsed.branch ? parsed.branch : 'main',
      token: typeof parsed.token === 'string' ? parsed.token : '',
    }
  }
  catch {
    return { owner: '', repo: '', branch: 'main', token: '' }
  }
}

export function saveGitHubConfig(config: GitHubConfig): void {
  localStorage.setItem(GITHUB_STORAGE_KEY, JSON.stringify(config))
}

export function clearGitHubConfig(): void {
  localStorage.removeItem(GITHUB_STORAGE_KEY)
}

export async function detectLocalMode(): Promise<{ available: boolean, formatSupported: boolean }> {
  try {
    const res = await fetch('/__admin_api/status', { cache: 'no-store' })
    if (!res.ok) {
      return { available: false, formatSupported: false }
    }
    const data = await res.json() as { ok?: boolean, features?: { format?: boolean } }
    return {
      available: Boolean(data.ok),
      formatSupported: Boolean(data.features?.format),
    }
  }
  catch {
    return { available: false, formatSupported: false }
  }
}

function getKindFromPath(filePath: string): ContentKind {
  return filePath.startsWith('src/content/about/') ? 'about' : 'post'
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function base64ToUtf8(b64: string): string {
  return new TextDecoder('utf-8').decode(base64ToBytes(b64))
}

export async function computeGitBlobSha1(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return ''
  }
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`)
  const payload = new Uint8Array(header.length + bytes.byteLength)
  payload.set(header, 0)
  payload.set(bytes, header.length)
  const digest = await globalThis.crypto.subtle.digest('SHA-1', payload)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取图片文件失败'))
    reader.readAsDataURL(file)
  })
}

async function loadImageFallback(file: File): Promise<{ width: number, height: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, cleanup: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
      cleanup: () => bitmap.close(),
    }
  }

  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
        cleanup: () => URL.revokeObjectURL(url),
      })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('解码图片失败'))
    }
    img.src = url
  })
}

export async function optimizeImageBeforeUpload(file: File): Promise<File> {
  const lowerName = (file.name || '').toLowerCase()
  if (file.type === 'image/svg+xml' || file.type === 'image/gif' || /\.(?:svg|gif)$/i.test(lowerName)) {
    return file
  }

  let decoded: Awaited<ReturnType<typeof loadImageFallback>> | null = null
  try {
    decoded = await loadImageFallback(file)
    const maxSide = Math.max(decoded.width, decoded.height)
    if (file.size <= IMAGE_SKIP_SIZE_BYTES && maxSide <= IMAGE_MAX_DIMENSION) {
      return file
    }

    const scale = maxSide > IMAGE_MAX_DIMENSION ? IMAGE_MAX_DIMENSION / maxSide : 1
    const targetW = Math.max(1, Math.round(decoded.width * scale))
    const targetH = Math.max(1, Math.round(decoded.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return file
    }
    decoded.draw(ctx, targetW, targetH)

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.88))
    if (!blob || blob.size >= file.size) {
      return file
    }

    const stem = (file.name || `image-${Date.now()}`).replace(/\.[^.]+$/, '')
    return new File([blob], `${stem}.webp`, {
      type: 'image/webp',
      lastModified: file.lastModified || Date.now(),
    })
  }
  catch {
    return file
  }
  finally {
    decoded?.cleanup()
  }
}

export class LocalStorageAdapter implements StorageAdapter {
  mode = 'local' as const

  async listFiles(): Promise<AdminFileSummary[]> {
    const res = await fetch('/__admin_api/files', { cache: 'no-store' })
    const data = await res.json() as {
      ok: boolean
      error?: string
      files?: Array<{ path: string, kind: ContentKind, mtimeMs: number, head: string }>
    }
    if (!res.ok || !data.ok || !data.files) {
      throw new Error(data.error || '加载本地文章列表失败')
    }

    return data.files.map((item) => {
      const parsed = parseMarkdownFile(item.head, item.kind)
      if (!parsed.meta.title && item.kind === 'post') {
        parsed.meta.title = item.path.split('/').pop()?.replace(/\.(?:md|mdx)$/i, '') || item.path
      }
      return {
        path: item.path,
        kind: item.kind,
        meta: parsed.meta,
        mtimeMs: item.mtimeMs,
      }
    })
  }

  async readFile(filePath: string): Promise<AdminFileData> {
    const res = await fetch(`/__admin_api/file?path=${encodeURIComponent(filePath)}`, { cache: 'no-store' })
    const data = await res.json() as {
      ok: boolean
      error?: string
      path?: string
      content?: string
      mtimeMs?: number
    }
    if (!res.ok || !data.ok || typeof data.content !== 'string') {
      throw new Error(data.error || `读取文件失败: ${filePath}`)
    }

    const kind = getKindFromPath(filePath)
    const parsed = parseMarkdownFile(data.content, kind)
    return {
      path: data.path || filePath,
      kind,
      content: data.content,
      meta: parsed.meta,
      body: parsed.body,
      mtimeMs: data.mtimeMs,
    }
  }

  async saveFile(
    filePath: string,
    content: string,
    opts?: { oldPath?: string },
  ): Promise<{ path: string, mtimeMs?: number }> {
    const res = await fetch('/__admin_api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: filePath,
        content,
        oldPath: opts?.oldPath,
      }),
    })
    const data = await res.json() as { ok: boolean, error?: string, path?: string, mtimeMs?: number }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || '保存本地文件失败')
    }
    return { path: data.path || filePath, mtimeMs: data.mtimeMs }
  }

  async deleteFile(filePath: string): Promise<void> {
    const res = await fetch(`/__admin_api/file?path=${encodeURIComponent(filePath)}`, {
      method: 'DELETE',
    })
    const data = await res.json() as { ok: boolean, error?: string }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || '删除本地文件失败')
    }
  }

  async uploadImage(file: File, postPath: string): Promise<ImageUploadResult> {
    const optimized = await optimizeImageBeforeUpload(file)
    const dataBase64 = await fileToBase64(optimized)
    const res = await fetch('/__admin_api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: optimized.name || `image-${Date.now()}.png`,
        dataBase64,
        postPath,
      }),
    })
    const data = await res.json() as {
      ok: boolean
      error?: string
      repoPath?: string
      markdownPath?: string
      previewUrl?: string
      hash?: string
      deduplicated?: boolean
      duplicateOf?: string
    }
    if (!res.ok || !data.ok || !data.repoPath || !data.markdownPath || !data.previewUrl) {
      throw new Error(data.error || '图片上传失败')
    }
    return {
      repoPath: data.repoPath,
      markdownPath: data.markdownPath,
      previewUrl: data.previewUrl,
      hash: data.hash,
      deduplicated: Boolean(data.deduplicated),
      duplicateOf: data.duplicateOf,
      pending: false,
    }
  }

  async listMedia(): Promise<AdminMediaItem[]> {
    const res = await fetch('/__admin_api/media-list', { cache: 'no-store' })
    const data = await res.json() as {
      ok: boolean
      error?: string
      items?: AdminMediaItem[]
    }
    if (!res.ok || !data.ok || !data.items) {
      throw new Error(data.error || '加载图片素材库失败')
    }
    return data.items
  }

  async listDocumentContents(): Promise<AdminDocContent[]> {
    const res = await fetch('/__admin_api/media-docs', { cache: 'no-store' })
    const data = await res.json() as {
      ok: boolean
      error?: string
      docs?: AdminDocContent[]
    }
    if (!res.ok || !data.ok || !data.docs) {
      throw new Error(data.error || '加载全站文章引用信息失败')
    }
    return data.docs
  }

  async deleteMedia(repoPath: string): Promise<void> {
    const res = await fetch(`/__admin_api/media?path=${encodeURIComponent(repoPath)}`, {
      method: 'DELETE',
    })
    const data = await res.json() as { ok: boolean, error?: string }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || '删除图片文件失败')
    }
  }

  async deleteMediaBatch(repoPaths: string[]): Promise<void> {
    if (repoPaths.length === 0) {
      return
    }
    const res = await fetch('/__admin_api/media-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: repoPaths }),
    })
    const data = await res.json() as { ok: boolean, error?: string }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || '批量删除图片文件失败')
    }
  }

  async resolveImagePreviewUrl(src: string, postPath: string): Promise<string | null> {
    const repoPath = src.startsWith('src/content/posts/')
      ? src
      : resolveRepoPathFromRelative(postPath, src)
    if (!repoPath) {
      return null
    }
    return `/__admin_api/media?path=${encodeURIComponent(repoPath)}`
  }

  async formatBody(body: string): Promise<string> {
    const res = await fetch('/__admin_api/format', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    })
    const data = await res.json() as { ok: boolean, error?: string, body?: string }
    if (!res.ok || !data.ok || typeof data.body !== 'string') {
      throw new Error(data.error || '自动排版失败')
    }
    return data.body
  }
}

interface PendingGitHubUpload {
  repoPath: string
  filename: string
  size: number
  hash: string
  base64Data: string
  previewUrl: string
}

export class GitHubStorageAdapter implements StorageAdapter {
  mode = 'github' as const
  private config: GitHubConfig
  private shaCache = new Map<string, string>()
  private fileContentCache = new Map<string, { content: string, sha: string }>()
  private mediaUrlCache = new Map<string, string>()
  private pendingUploads = new Map<string, PendingGitHubUpload>()
  private remoteMediaCache: AdminMediaItem[] | null = null
  private uploadSeq = 0

  constructor(config: GitHubConfig) {
    this.config = {
      owner: config.owner.trim(),
      repo: config.repo.trim(),
      branch: config.branch.trim() || 'main',
      token: config.token.trim(),
    }
  }

  private encodeRepoPath(repoPath: string): string {
    return repoPath
      .replace(/^\/+/, '')
      .split('/')
      .map(seg => encodeURIComponent(seg))
      .join('/')
  }

  private async request<T>(apiPath: string, init: RequestInit = {}): Promise<T> {
    if (!this.config.owner || !this.config.repo || !this.config.token) {
      throw new Error('请先在 GitHub 设置中填写仓库信息与 Fine-Grained Token')
    }

    const method = (init.method || 'GET').toUpperCase()
    const cacheBustedPath = method === 'GET'
      ? `${apiPath}${apiPath.includes('?') ? '&' : '?'}_t=${Date.now()}`
      : apiPath
    const url = `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}${cacheBustedPath}`

    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.config.token}`)
    headers.set('Accept', 'application/vnd.github+json')
    headers.set('X-GitHub-Api-Version', '2022-11-28')

    const res = await fetch(url, { ...init, headers, cache: 'no-store' })
    if (!res.ok) {
      let msg = `GitHub API 错误 (${res.status})`
      try {
        const errJson = await res.json() as { message?: string }
        if (errJson.message) {
          msg = `${msg}: ${errJson.message}`
        }
      }
      catch {
        // ignore JSON parse failure
      }
      throw new Error(msg)
    }

    if (res.status === 204) {
      return undefined as T
    }
    return await res.json() as T
  }

  getPendingUploadCount(): number {
    return this.pendingUploads.size
  }

  clearPendingUploads(): void {
    for (const item of this.pendingUploads.values()) {
      URL.revokeObjectURL(item.previewUrl)
      this.mediaUrlCache.delete(item.repoPath)
    }
    this.pendingUploads.clear()
  }

  getActionsUrl(): string | null {
    if (!this.config.owner || !this.config.repo) {
      return null
    }
    return `https://github.com/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/actions`
  }

  async verifyConnection(): Promise<{ fullName: string, canPush: boolean, defaultBranch: string }> {
    const repoInfo = await this.request<{
      full_name: string
      default_branch: string
      permissions?: { push?: boolean }
    }>('')
    return {
      fullName: repoInfo.full_name,
      canPush: repoInfo.permissions?.push ?? true,
      defaultBranch: repoInfo.default_branch,
    }
  }

  async listFiles(): Promise<AdminFileSummary[]> {
    const refData = await this.request<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(this.config.branch)}`)
    const tree = await this.request<{
      tree: Array<{ path: string, type: string, sha: string }>
    }>(`/git/trees/${refData.object.sha}?recursive=1`)

    const mdEntries = tree.tree.filter((item) => {
      if (item.type !== 'blob') {
        return false
      }
      const inPosts = item.path.startsWith('src/content/posts/') && !item.path.startsWith('src/content/posts/_images/')
      const inAbout = item.path.startsWith('src/content/about/')
      return (inPosts || inAbout) && /\.(?:md|mdx)$/i.test(item.path)
    })

    const results: AdminFileSummary[] = []
    const batchSize = 6
    for (let i = 0; i < mdEntries.length; i += batchSize) {
      const batch = mdEntries.slice(i, i + batchSize)
      const batchData = await Promise.all(
        batch.map(async (entry) => {
          this.shaCache.set(entry.path, entry.sha)
          const cached = this.fileContentCache.get(entry.path)
          if (cached && cached.sha === entry.sha) {
            const kind = getKindFromPath(entry.path)
            const parsed = parseMarkdownFile(cached.content, kind)
            if (!parsed.meta.title && kind === 'post') {
              parsed.meta.title = entry.path.split('/').pop()?.replace(/\.(?:md|mdx)$/i, '') || entry.path
            }
            return {
              path: entry.path,
              kind,
              meta: parsed.meta,
              sha: entry.sha,
            } satisfies AdminFileSummary
          }

          this.fileContentCache.delete(entry.path)
          const file = await this.readFile(entry.path)
          if (!file.meta.title && file.kind === 'post') {
            file.meta.title = entry.path.split('/').pop()?.replace(/\.(?:md|mdx)$/i, '') || entry.path
          }
          return {
            path: entry.path,
            kind: file.kind,
            meta: file.meta,
            sha: file.sha,
          } satisfies AdminFileSummary
        }),
      )
      results.push(...batchData)
    }

    return results
  }

  async readFile(filePath: string): Promise<AdminFileData> {
    const memCached = this.fileContentCache.get(filePath)
    if (memCached) {
      const kind = getKindFromPath(filePath)
      const parsed = parseMarkdownFile(memCached.content, kind)
      return {
        path: filePath,
        kind,
        content: memCached.content,
        meta: parsed.meta,
        body: parsed.body,
        sha: memCached.sha,
      }
    }

    const encoded = this.encodeRepoPath(filePath)
    const ref = encodeURIComponent(this.config.branch)
    const data = await this.request<{
      path: string
      sha: string
      content?: string
      encoding?: string
    }>(`/contents/${encoded}?ref=${ref}`)

    this.shaCache.set(filePath, data.sha)
    let rawText = ''
    if (data.content) {
      rawText = base64ToUtf8(data.content)
    }
    else if (data.sha) {
      const blobData = await this.request<{ content?: string }>(`/git/blobs/${data.sha}`)
      rawText = blobData.content ? base64ToUtf8(blobData.content) : ''
    }

    const resolvedPath = data.path || filePath
    this.fileContentCache.set(resolvedPath, { content: rawText, sha: data.sha })

    const kind = getKindFromPath(resolvedPath)
    const parsed = parseMarkdownFile(rawText, kind)

    return {
      path: resolvedPath,
      kind,
      content: rawText,
      meta: parsed.meta,
      body: parsed.body,
      sha: data.sha,
    }
  }

  private async getRemoteShaIfExists(filePath: string): Promise<string | undefined> {
    const cached = this.shaCache.get(filePath)
    if (cached) {
      return cached
    }
    try {
      const encoded = this.encodeRepoPath(filePath)
      const ref = encodeURIComponent(this.config.branch)
      const data = await this.request<{ sha: string }>(`/contents/${encoded}?ref=${ref}`)
      this.shaCache.set(filePath, data.sha)
      return data.sha
    }
    catch {
      return undefined
    }
  }

  private async commitAtomic(
    writes: Array<{ path: string, base64Content: string, rawText?: string }>,
    deletes: string[],
    commitMessage: string,
  ): Promise<Map<string, string>> {
    const encodedBranch = encodeURIComponent(this.config.branch)
    const refData = await this.request<{ object: { sha: string } }>(`/git/ref/heads/${encodedBranch}`)
    const headSha = refData.object.sha

    const commitData = await this.request<{ tree: { sha: string } }>(`/git/commits/${headSha}`)
    const baseTreeSha = commitData.tree.sha

    const createdBlobs = await Promise.all(
      writes.map(async (item) => {
        const blob = await this.request<{ sha: string }>('/git/blobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: item.base64Content,
            encoding: 'base64',
          }),
        })
        return { ...item, sha: blob.sha }
      }),
    )

    const treeEntries: Array<{ path: string, mode: '100644', type: 'blob', sha: string | null }> = [
      ...createdBlobs.map(item => ({
        path: item.path,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: item.sha,
      })),
      ...deletes.map(delPath => ({
        path: delPath,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: null,
      })),
    ]

    const treeRes = await this.request<{ sha: string }>('/git/trees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeEntries,
      }),
    })

    const newCommitRes = await this.request<{ sha: string }>('/git/commits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage,
        tree: treeRes.sha,
        parents: [headSha],
      }),
    })

    await this.request(`/git/refs/heads/${encodedBranch}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sha: newCommitRes.sha,
        force: false,
      }),
    })

    const shaResult = new Map<string, string>()
    for (const item of createdBlobs) {
      this.shaCache.set(item.path, item.sha)
      shaResult.set(item.path, item.sha)
      if (typeof item.rawText === 'string') {
        this.fileContentCache.set(item.path, { content: item.rawText, sha: item.sha })
      }
    }
    for (const delPath of deletes) {
      this.shaCache.delete(delPath)
      this.fileContentCache.delete(delPath)
    }

    return shaResult
  }

  async saveFile(
    filePath: string,
    content: string,
    opts?: { oldPath?: string, commitMessage?: string },
  ): Promise<{ path: string, sha?: string }> {
    const writes: Array<{ path: string, base64Content: string, rawText?: string }> = [
      {
        path: filePath,
        base64Content: utf8ToBase64(content),
        rawText: content,
      },
    ]

    for (const pending of this.pendingUploads.values()) {
      writes.push({
        path: pending.repoPath,
        base64Content: pending.base64Data,
      })
    }

    const deletes: string[] = []
    if (opts?.oldPath && opts.oldPath !== filePath && opts.oldPath.startsWith('src/content/posts/')) {
      deletes.push(opts.oldPath)
    }

    const commitMsg = opts?.commitMessage || `post: save ${filePath}`
    const shaMap = await this.commitAtomic(writes, deletes, commitMsg)

    this.pendingUploads.clear()
    this.remoteMediaCache = null

    return {
      path: filePath,
      sha: shaMap.get(filePath),
    }
  }

  async commitPendingUploads(): Promise<number> {
    if (this.pendingUploads.size === 0) {
      return 0
    }
    const entries = Array.from(this.pendingUploads.values())
    const writes = entries.map(item => ({
      path: item.repoPath,
      base64Content: item.base64Data,
    }))
    await this.commitAtomic(writes, [], `assets: upload ${entries.length} image(s)`)
    this.pendingUploads.clear()
    this.remoteMediaCache = null
    return entries.length
  }

  async listDocumentContents(): Promise<AdminDocContent[]> {
    if (this.fileContentCache.size === 0) {
      await this.listFiles()
    }
    const docs: AdminDocContent[] = []
    for (const [docPath, cached] of this.fileContentCache.entries()) {
      const kind = getKindFromPath(docPath)
      const parsed = parseMarkdownFile(cached.content, kind)
      const fallbackTitle = docPath.split('/').pop()?.replace(/\.(?:md|mdx)$/i, '') || docPath
      docs.push({
        path: docPath,
        kind,
        title: parsed.meta.title || fallbackTitle,
        content: cached.content,
      })
    }
    return docs
  }

  async deleteFile(filePath: string, opts?: { commitMessage?: string }): Promise<void> {
    if (!filePath.startsWith('src/content/posts/')) {
      throw new Error('仅允许删除 src/content/posts/ 下的文章')
    }
    const sha = await this.getRemoteShaIfExists(filePath)
    if (!sha) {
      throw new Error(`未找到远端文件 SHA: ${filePath}`)
    }

    const encoded = this.encodeRepoPath(filePath)
    await this.request(`/contents/${encoded}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: opts?.commitMessage || `post: delete ${filePath}`,
        sha,
        branch: this.config.branch,
      }),
    })

    this.shaCache.delete(filePath)
    this.fileContentCache.delete(filePath)
  }

  private async listRemoteMediaOnly(): Promise<AdminMediaItem[]> {
    const ref = encodeURIComponent(this.config.branch)
    let remoteItems: AdminMediaItem[] = []
    try {
      const entries = await this.request<Array<{
        name: string
        path: string
        sha: string
        size: number
        type: string
      }>>(`/contents/src/content/posts/_images?ref=${ref}`)

      remoteItems = entries
        .filter(item => item.type === 'file' && /\.(?:png|jpe?g|webp|gif|svg|avif)$/i.test(item.name))
        .map((item) => {
          this.shaCache.set(item.path, item.sha)
          return {
            repoPath: item.path,
            filename: item.name,
            size: item.size,
            previewUrl: this.mediaUrlCache.get(item.path) || '',
            hash: item.sha,
            pending: false,
          }
        })
      this.remoteMediaCache = remoteItems
    }
    catch (err) {
      if (!(err instanceof Error && err.message.includes('(404)'))) {
        throw err
      }
      this.remoteMediaCache = []
    }
    return remoteItems
  }

  async uploadImage(file: File, postPath: string): Promise<ImageUploadResult> {
    const optimized = await optimizeImageBeforeUpload(file)
    if (optimized.size === 0 || optimized.size > 10 * 1024 * 1024) {
      throw new Error('图片大小需在 1B 到 10MB 之间')
    }

    const bytes = new Uint8Array(await optimized.arrayBuffer())
    const hash = await computeGitBlobSha1(bytes)

    if (hash) {
      for (const pending of this.pendingUploads.values()) {
        if (pending.hash && pending.hash === hash) {
          return {
            repoPath: pending.repoPath,
            markdownPath: computeRelativeImagePath(postPath, pending.repoPath),
            previewUrl: pending.previewUrl,
            hash,
            deduplicated: true,
            duplicateOf: pending.filename,
            pending: true,
          }
        }
      }

      const remoteList = this.remoteMediaCache ?? await this.listRemoteMediaOnly()
      const remoteMatch = remoteList.find(item => item.hash && item.hash === hash)
      if (remoteMatch) {
        return {
          repoPath: remoteMatch.repoPath,
          markdownPath: computeRelativeImagePath(postPath, remoteMatch.repoPath),
          previewUrl: remoteMatch.previewUrl,
          hash,
          deduplicated: true,
          duplicateOf: remoteMatch.filename,
          pending: false,
        }
      }
    }

    const extMatch = (optimized.name || '').match(/\.(png|jpg|jpeg|webp|gif|svg|avif)$/i)
    const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : '.png'
    const rawStem = (optimized.name || 'image').replace(/\.[^.]+$/, '')
    const stem = rawStem
      .replace(/[^\w\u4E00-\u9FA5-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'img'

    this.uploadSeq += 1
    const uniqueName = `${stem}-${Date.now().toString(36)}${this.uploadSeq.toString(36)}${ext}`
    const repoPath = `src/content/posts/_images/${uniqueName}`
    const base64Data = bytesToBase64(bytes)
    const previewUrl = URL.createObjectURL(optimized)

    this.mediaUrlCache.set(repoPath, previewUrl)
    this.pendingUploads.set(repoPath, {
      repoPath,
      filename: uniqueName,
      size: optimized.size,
      hash,
      base64Data,
      previewUrl,
    })

    return {
      repoPath,
      markdownPath: computeRelativeImagePath(postPath, repoPath),
      previewUrl,
      hash,
      deduplicated: false,
      pending: true,
    }
  }

  async listMedia(): Promise<AdminMediaItem[]> {
    const pendingItems: AdminMediaItem[] = Array.from(this.pendingUploads.values()).map(item => ({
      repoPath: item.repoPath,
      filename: item.filename,
      size: item.size,
      previewUrl: item.previewUrl,
      hash: item.hash,
      pending: true,
    }))

    const remoteItems = await this.listRemoteMediaOnly()
    const seen = new Set(pendingItems.map(i => i.repoPath))
    return [...pendingItems, ...remoteItems.filter(i => !seen.has(i.repoPath))]
  }

  async deleteMedia(repoPath: string): Promise<void> {
    await this.deleteMediaBatch([repoPath])
  }

  async deleteMediaBatch(repoPaths: string[]): Promise<void> {
    const uniquePaths = Array.from(new Set(repoPaths))
    if (uniquePaths.length === 0) {
      return
    }
    for (const repoPath of uniquePaths) {
      if (!repoPath.startsWith('src/content/posts/_images/')) {
        throw new Error(`仅允许删除 src/content/posts/_images/ 下的图片资源: ${repoPath}`)
      }
    }

    const remoteCandidates: string[] = []
    for (const repoPath of uniquePaths) {
      const pendingItem = this.pendingUploads.get(repoPath)
      if (pendingItem) {
        URL.revokeObjectURL(pendingItem.previewUrl)
        this.pendingUploads.delete(repoPath)
        this.mediaUrlCache.delete(repoPath)
      }
      else {
        remoteCandidates.push(repoPath)
      }
    }

    if (remoteCandidates.length === 0) {
      return
    }

    const remoteList = await this.listRemoteMediaOnly()
    const remoteSet = new Set(remoteList.map(i => i.repoPath))
    const existingDeletes = remoteCandidates.filter(p => remoteSet.has(p))
    if (existingDeletes.length > 0) {
      const commitMsg = existingDeletes.length === 1
        ? `assets: delete ${existingDeletes[0]}`
        : `assets: delete ${existingDeletes.length} images`
      await this.commitAtomic([], existingDeletes, commitMsg)
    }

    this.remoteMediaCache = null
    for (const repoPath of remoteCandidates) {
      this.shaCache.delete(repoPath)
      const oldBlob = this.mediaUrlCache.get(repoPath)
      if (oldBlob) {
        URL.revokeObjectURL(oldBlob)
        this.mediaUrlCache.delete(repoPath)
      }
    }
  }

  async resolveImagePreviewUrl(src: string, postPath: string): Promise<string | null> {
    const repoPath = src.startsWith('src/content/posts/')
      ? src
      : resolveRepoPathFromRelative(postPath, src)
    if (!repoPath) {
      return null
    }
    const cached = this.mediaUrlCache.get(repoPath)
    if (cached) {
      return cached
    }

    try {
      const encoded = this.encodeRepoPath(repoPath)
      const ref = encodeURIComponent(this.config.branch)
      const data = await this.request<{ sha?: string, content?: string }>(`/contents/${encoded}?ref=${ref}`)

      let base64Content = data.content || ''
      if (!base64Content && data.sha) {
        this.shaCache.set(repoPath, data.sha)
        const blobData = await this.request<{ content?: string }>(`/git/blobs/${data.sha}`)
        base64Content = blobData.content || ''
      }
      if (!base64Content) {
        return null
      }

      const ext = repoPath.split('.').pop()?.toLowerCase() || 'png'
      const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        avif: 'image/avif',
      }
      const bytes = base64ToBytes(base64Content)
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      const blob = new Blob([arrayBuffer], { type: mimeMap[ext] || 'image/png' })
      const blobUrl = URL.createObjectURL(blob)
      this.mediaUrlCache.set(repoPath, blobUrl)
      return blobUrl
    }
    catch {
      return null
    }
  }
}

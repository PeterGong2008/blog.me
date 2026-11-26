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
}

export interface AdminMediaItem {
  repoPath: string
  filename: string
  size: number
  mtimeMs?: number
  previewUrl: string
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
  resolveImagePreviewUrl: (src: string, postPath: string) => Promise<string | null>
  formatBody?: (body: string) => Promise<string>
}

const GITHUB_STORAGE_KEY = 'retypeset-admin-github-config'

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
    const dataBase64 = await fileToBase64(file)
    const res = await fetch('/__admin_api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name || `image-${Date.now()}.png`,
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
    }
    if (!res.ok || !data.ok || !data.repoPath || !data.markdownPath || !data.previewUrl) {
      throw new Error(data.error || '图片上传失败')
    }
    return {
      repoPath: data.repoPath,
      markdownPath: data.markdownPath,
      previewUrl: data.previewUrl,
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

  async deleteMedia(repoPath: string): Promise<void> {
    const res = await fetch(`/__admin_api/media?path=${encodeURIComponent(repoPath)}`, {
      method: 'DELETE',
    })
    const data = await res.json() as { ok: boolean, error?: string }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || '删除图片文件失败')
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

export class GitHubStorageAdapter implements StorageAdapter {
  mode = 'github' as const
  private config: GitHubConfig
  private shaCache = new Map<string, string>()
  private mediaUrlCache = new Map<string, string>()

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

    const url = `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}${apiPath}`
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
    const branchRef = encodeURIComponent(this.config.branch)
    const tree = await this.request<{
      tree: Array<{ path: string, type: string, sha: string }>
    }>(`/git/trees/${branchRef}?recursive=1`)

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
    const encoded = this.encodeRepoPath(filePath)
    const ref = encodeURIComponent(this.config.branch)
    const data = await this.request<{
      path: string
      sha: string
      content?: string
      encoding?: string
    }>(`/contents/${encoded}?ref=${ref}`)

    this.shaCache.set(filePath, data.sha)
    const rawText = data.content ? base64ToUtf8(data.content) : ''
    const kind = getKindFromPath(filePath)
    const parsed = parseMarkdownFile(rawText, kind)

    return {
      path: data.path || filePath,
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

  async saveFile(
    filePath: string,
    content: string,
    opts?: { oldPath?: string, commitMessage?: string },
  ): Promise<{ path: string, sha?: string }> {
    const encoded = this.encodeRepoPath(filePath)
    const existingSha = await this.getRemoteShaIfExists(filePath)

    const payload: Record<string, string> = {
      message: opts?.commitMessage || (existingSha ? `post: update ${filePath}` : `post: create ${filePath}`),
      content: utf8ToBase64(content),
      branch: this.config.branch,
    }
    if (existingSha) {
      payload.sha = existingSha
    }

    const res = await this.request<{ content: { path: string, sha: string } }>(`/contents/${encoded}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const savedPath = res.content.path || filePath
    this.shaCache.set(savedPath, res.content.sha)

    if (opts?.oldPath && opts.oldPath !== savedPath && opts.oldPath.startsWith('src/content/posts/')) {
      await this.deleteFile(opts.oldPath, {
        commitMessage: `post: remove old path ${opts.oldPath}`,
      }).catch(() => {})
    }

    return { path: savedPath, sha: res.content.sha }
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
  }

  async uploadImage(file: File, postPath: string): Promise<ImageUploadResult> {
    if (file.size === 0 || file.size > 10 * 1024 * 1024) {
      throw new Error('图片大小需在 1B 到 10MB 之间')
    }

    const extMatch = (file.name || '').match(/\.(png|jpg|jpeg|webp|gif|svg|avif)$/i)
    const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : '.png'
    const rawStem = (file.name || 'image').replace(/\.[^.]+$/, '')
    const stem = rawStem
      .replace(/[^\w\u4E00-\u9FA5-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'img'

    const uniqueName = `${stem}-${Date.now().toString(36)}${ext}`
    const repoPath = `src/content/posts/_images/${uniqueName}`
    const base64Data = await fileToBase64(file)
    const encoded = this.encodeRepoPath(repoPath)

    const res = await this.request<{ content: { path: string, sha: string } }>(`/contents/${encoded}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `assets: upload ${uniqueName}`,
        content: base64Data,
        branch: this.config.branch,
      }),
    })

    this.shaCache.set(repoPath, res.content.sha)
    const previewUrl = URL.createObjectURL(file)
    this.mediaUrlCache.set(repoPath, previewUrl)

    return {
      repoPath,
      markdownPath: computeRelativeImagePath(postPath, repoPath),
      previewUrl,
    }
  }

  async listMedia(): Promise<AdminMediaItem[]> {
    const ref = encodeURIComponent(this.config.branch)
    try {
      const entries = await this.request<Array<{
        name: string
        path: string
        sha: string
        size: number
        type: string
      }>>(`/contents/src/content/posts/_images?ref=${ref}`)

      return entries
        .filter(item => item.type === 'file' && /\.(?:png|jpe?g|webp|gif|svg|avif)$/i.test(item.name))
        .map((item) => {
          this.shaCache.set(item.path, item.sha)
          return {
            repoPath: item.path,
            filename: item.name,
            size: item.size,
            previewUrl: this.mediaUrlCache.get(item.path) || '',
          }
        })
    }
    catch (err) {
      if (err instanceof Error && err.message.includes('(404)')) {
        return []
      }
      throw err
    }
  }

  async deleteMedia(repoPath: string): Promise<void> {
    if (!repoPath.startsWith('src/content/posts/_images/')) {
      throw new Error('仅允许删除 src/content/posts/_images/ 下的图片资源')
    }
    const sha = await this.getRemoteShaIfExists(repoPath)
    if (!sha) {
      throw new Error(`未找到远端图片 SHA: ${repoPath}`)
    }
    const encoded = this.encodeRepoPath(repoPath)
    await this.request(`/contents/${encoded}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `assets: delete ${repoPath}`,
        sha,
        branch: this.config.branch,
      }),
    })
    this.shaCache.delete(repoPath)
    const oldBlob = this.mediaUrlCache.get(repoPath)
    if (oldBlob) {
      URL.revokeObjectURL(oldBlob)
      this.mediaUrlCache.delete(repoPath)
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
      const data = await this.request<{ content?: string }>(`/contents/${encoded}?ref=${ref}`)
      if (!data.content) {
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
      const bytes = base64ToBytes(data.content)
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

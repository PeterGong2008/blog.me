import { base } from '@/config'

export type PostLang = '' | 'zh' | 'en'
export type ContentKind = 'post' | 'about'

export interface PostMeta {
  title: string
  published: string
  updated: string
  description: string
  tags: string[]
  draft: boolean
  pin: number
  toc: boolean
  lang: PostLang
  abbrlink: string
  extra: Record<string, string>
}

export interface ParsedMarkdownFile {
  meta: PostMeta
  body: string
}

const KNOWN_POST_KEYS = new Set([
  'title',
  'published',
  'updated',
  'description',
  'tags',
  'draft',
  'pin',
  'toc',
  'lang',
  'abbrlink',
])

export function getTodayDateString(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function createDefaultPostMeta(lang: PostLang = 'zh', title = ''): PostMeta {
  return {
    title,
    published: getTodayDateString(),
    updated: '',
    description: '',
    tags: [],
    draft: false,
    pin: 0,
    toc: true,
    lang,
    abbrlink: '',
    extra: {},
  }
}

function unquoteYaml(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    if (trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
      return trimmed.slice(1, -1).replace(/''/g, '\'')
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\\\/g, '\\')
    }
  }
  return trimmed
}

function normalizeDateField(raw: string): string {
  const val = unquoteYaml(raw)
  if (!val) {
    return ''
  }
  const match = val.match(/^(\d{4}-\d{2}-\d{2})/)
  if (match) {
    return match[1]
  }
  const parsed = new Date(val)
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10)
  }
  return val
}

function quoteYamlString(value: string): string {
  if (value === '') {
    return '\'\''
  }

  const needsQuote = (
    /^\s|\s$/.test(value)
    || /[:#[\]{}&*!|>'"%@`]/.test(value)
    || /^(?:true|false|yes|no|null|~)$/i.test(value)
    || /^[+-]?\d+(?:\.\d+)?$/.test(value)
    || /^\d{4}-\d{2}-\d{2}/.test(value)
  )

  if (!needsQuote) {
    return value
  }

  return `'${value.replace(/'/g, '\'\'')}'`
}

function parseInlineYamlArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim()
  if (!inner) {
    return []
  }
  return inner
    .split(',')
    .map(item => unquoteYaml(item))
    .filter(Boolean)
}

export function parseMarkdownFile(raw: string, kind: ContentKind = 'post'): ParsedMarkdownFile {
  const meta = createDefaultPostMeta(kind === 'about' ? 'zh' : '')
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { meta, body: raw }
  }

  const fmBlock = match[1]
  const body = match[2].replace(/^\r?\n/, '')
  const lines = fmBlock.split(/\r?\n/)

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) {
      i += 1
      continue
    }

    const kvMatch = line.match(/^([\w-]+):(.*)$/)
    if (!kvMatch) {
      i += 1
      continue
    }

    const key = kvMatch[1].trim()
    const rawRest = kvMatch[2].trim()

    if (key === 'tags') {
      if (rawRest.startsWith('[') && rawRest.endsWith(']')) {
        meta.tags = parseInlineYamlArray(rawRest)
        i += 1
        continue
      }

      const items: string[] = []
      if (rawRest) {
        items.push(unquoteYaml(rawRest))
      }
      let j = i + 1
      while (j < lines.length) {
        const nextLine = lines[j]
        const itemMatch = nextLine.match(/^\s+-[ \t]*(\S.*)$/)
        if (!itemMatch) {
          break
        }
        const tagVal = unquoteYaml(itemMatch[1])
        if (tagVal) {
          items.push(tagVal)
        }
        j += 1
      }
      meta.tags = items
      i = j
      continue
    }

    if (!KNOWN_POST_KEYS.has(key)) {
      meta.extra[key] = rawRest
      i += 1
      continue
    }

    const val = unquoteYaml(rawRest)
    switch (key) {
      case 'title':
        meta.title = val
        break
      case 'published':
        meta.published = normalizeDateField(rawRest)
        break
      case 'updated':
        meta.updated = normalizeDateField(rawRest)
        break
      case 'description':
        meta.description = val
        break
      case 'draft':
        meta.draft = val.toLowerCase() === 'true'
        break
      case 'pin': {
        const n = Number.parseInt(val, 10)
        meta.pin = Number.isFinite(n) ? Math.min(99, Math.max(0, n)) : 0
        break
      }
      case 'toc':
        meta.toc = val.toLowerCase() !== 'false'
        break
      case 'lang':
        meta.lang = val === 'zh' || val === 'en' ? val : ''
        break
      case 'abbrlink':
        meta.abbrlink = val
        break
    }
    i += 1
  }

  return { meta, body }
}

export function serializeMarkdownFile(meta: PostMeta, body: string, kind: ContentKind = 'post'): string {
  const cleanBody = body.replace(/\r\n/g, '\n').replace(/^\n+/, '')

  if (kind === 'about') {
    const aboutLang = meta.lang === 'en' ? 'en' : 'zh'
    return `---\nlang: ${aboutLang}\n---\n\n${cleanBody}`
  }

  const lines: string[] = ['---']
  lines.push(`title: ${quoteYamlString(meta.title.trim())}`)
  lines.push(`published: ${meta.published.trim() || getTodayDateString()}`)

  if (meta.updated.trim()) {
    lines.push(`updated: ${meta.updated.trim()}`)
  }

  if (meta.description.trim()) {
    lines.push(`description: ${quoteYamlString(meta.description.trim())}`)
  }

  const cleanTags = meta.tags.map(t => t.trim()).filter(Boolean)
  if (cleanTags.length > 0) {
    lines.push('tags:')
    for (const tag of cleanTags) {
      lines.push(`  - ${quoteYamlString(tag)}`)
    }
  }

  if (meta.draft) {
    lines.push('draft: true')
  }

  if (meta.pin > 0) {
    lines.push(`pin: ${Math.min(99, Math.max(0, Math.round(meta.pin)))}`)
  }

  if (!meta.toc) {
    lines.push('toc: false')
  }

  if (meta.lang === 'zh' || meta.lang === 'en') {
    lines.push(`lang: ${meta.lang}`)
  }

  if (meta.abbrlink.trim()) {
    lines.push(`abbrlink: ${meta.abbrlink.trim()}`)
  }

  for (const [key, rawVal] of Object.entries(meta.extra)) {
    if (!KNOWN_POST_KEYS.has(key) && rawVal !== undefined) {
      lines.push(`${key}: ${rawVal}`)
    }
  }

  lines.push('---')
  return `${lines.join('\n')}\n\n${cleanBody}`
}

export function validatePostMeta(meta: PostMeta, kind: ContentKind = 'post'): string[] {
  const errors: string[] = []

  if (kind === 'about') {
    if (meta.lang !== 'zh' && meta.lang !== 'en') {
      errors.push('关于页面语言必须为 zh 或 en')
    }
    return errors
  }

  if (!meta.title.trim()) {
    errors.push('文章标题不能为空')
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.published.trim())) {
    errors.push('发布日期格式需为 YYYY-MM-DD')
  }

  if (meta.updated.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(meta.updated.trim())) {
    errors.push('更新日期格式需为 YYYY-MM-DD')
  }

  if (!Number.isInteger(meta.pin) || meta.pin < 0 || meta.pin > 99) {
    errors.push('置顶权重需为 0 到 99 的整数')
  }

  if (!['', 'zh', 'en'].includes(meta.lang)) {
    errors.push('语言选项仅支持 zh、en 或通用（留空）')
  }

  if (meta.abbrlink.trim() && !/^[a-z0-9-]+$/.test(meta.abbrlink.trim())) {
    errors.push('自定义链接（abbrlink）只能包含小写字母、数字和短横线 -')
  }

  return errors
}

export function suggestSlug(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

  return ascii || `post-${getTodayDateString().replace(/-/g, '')}`
}

export function computePostSlug(repoPath: string, meta: PostMeta): string {
  if (meta.abbrlink.trim()) {
    return meta.abbrlink.trim()
  }
  const withoutPrefix = repoPath
    .replace(/^src\/content\/posts\//, '')
    .replace(/\.(?:md|mdx)$/i, '')
  return withoutPrefix.toLowerCase().replace(/\s+/g, '-')
}

export function computePostRoute(repoPath: string, meta: PostMeta): string {
  const slug = computePostSlug(repoPath, meta)
  if (meta.lang === 'en') {
    return `${base}/en/posts/${slug}/`
  }
  return `${base}/posts/${slug}/`
}

export function computeRelativeImagePath(postPath: string, imageRepoPath: string): string {
  const postDir = postPath.replace(/\\/g, '/').split('/').slice(0, -1)
  const imgParts = imageRepoPath.replace(/\\/g, '/').split('/')

  let common = 0
  while (common < postDir.length && common < imgParts.length - 1 && postDir[common] === imgParts[common]) {
    common += 1
  }

  const upCount = postDir.length - common
  const rest = imgParts.slice(common).join('/')
  if (upCount === 0) {
    return `./${rest}`
  }
  return `${'../'.repeat(upCount)}${rest}`
}

export function resolveRepoPathFromRelative(postPath: string, relSrc: string): string | null {
  if (!relSrc || /^(?:https?:|data:|blob:|\/)/i.test(relSrc)) {
    return null
  }

  const baseParts = postPath.replace(/\\/g, '/').split('/').slice(0, -1)
  const srcParts = relSrc.replace(/\\/g, '/').split('/')

  for (const part of srcParts) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      if (baseParts.length === 0) {
        return null
      }
      baseParts.pop()
    }
    else {
      baseParts.push(part)
    }
  }

  const resolved = baseParts.join('/')
  if (!resolved.startsWith('src/content/posts/')) {
    return null
  }
  return resolved
}

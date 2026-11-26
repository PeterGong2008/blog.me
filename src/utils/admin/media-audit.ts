import type { AdminDocContent, AdminMediaItem } from './storage'
import { resolveRepoPathFromRelative } from './frontmatter'

export interface MediaDocRef {
  path: string
  kind: 'post' | 'about'
  title: string
}

export interface AuditedMediaInfo {
  repoPath: string
  refs: MediaDocRef[]
  usedInActivePost: boolean
  usedGlobally: boolean
  duplicateGroupId: number | null
  duplicatePeers: string[]
  isCanonicalInGroup: boolean
  safeDuplicateDeletable: boolean
}

export interface DuplicateGroupReport {
  groupId: number
  hash: string
  canonicalPath: string
  redundantPaths: string[]
  safeUnusedRedundantPaths: string[]
  itemPaths: string[]
  reclaimableBytes: number
}

export interface GlobalMediaAuditResult {
  byPath: Map<string, AuditedMediaInfo>
  duplicateGroups: DuplicateGroupReport[]
  totalCount: number
  totalBytes: number
  pendingCount: number
  globallyUnusedPaths: string[]
  globallyUnusedBytes: number
  safeDuplicateDeletablePaths: string[]
  safeDuplicateReclaimBytes: number
}

function safeDecodeUri(raw: string): string {
  try {
    return decodeURIComponent(raw)
  }
  catch {
    return raw
  }
}

function extractResolvedImagePaths(docPath: string, content: string): Set<string> {
  const resolved = new Set<string>()
  const addCandidate = (rawSrc: string) => {
    const clean = safeDecodeUri(rawSrc.trim().replace(/^<|>$/g, ''))
    if (!clean) {
      return
    }
    if (clean.startsWith('src/content/posts/')) {
      resolved.add(clean)
      return
    }
    const repoPath = resolveRepoPathFromRelative(docPath, clean)
    if (repoPath) {
      resolved.add(repoPath)
    }
  }

  // Markdown image targets: ![alt](src "title")
  const mdImgRegex = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let match = mdImgRegex.exec(content)
  while (match !== null) {
    addCandidate(match[1])
    match = mdImgRegex.exec(content)
  }

  // HTML <img src="..."> or <a href="...">
  const attrRegex = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi
  let attrMatch = attrRegex.exec(content)
  while (attrMatch !== null) {
    addCandidate(attrMatch[1])
    attrMatch = attrRegex.exec(content)
  }

  return resolved
}

function docReferencesMedia(
  content: string,
  extractedPaths: Set<string>,
  item: AdminMediaItem,
): boolean {
  if (extractedPaths.has(item.repoPath)) {
    return true
  }
  const relUnderPosts = item.repoPath.replace(/^src\/content\/posts\//, '')
  if (content.includes(relUnderPosts) || content.includes(encodeURI(relUnderPosts))) {
    return true
  }
  const encodedName = encodeURIComponent(item.filename)
  return (
    content.includes(`/_images/${item.filename}`)
    || content.includes(`/_images/${encodedName}`)
    || content.includes(`/${item.filename}`)
    || content.includes(`/${encodedName}`)
  )
}

export function auditMediaLibrary(opts: {
  items: AdminMediaItem[]
  docs: AdminDocContent[]
  activePath: string | null
  activeTitle?: string
  activeBody?: string
}): GlobalMediaAuditResult {
  const docList: AdminDocContent[] = opts.docs.map(d => ({ ...d }))
  if (opts.activePath && typeof opts.activeBody === 'string') {
    const idx = docList.findIndex(d => d.path === opts.activePath)
    if (idx >= 0) {
      docList[idx] = {
        ...docList[idx],
        title: opts.activeTitle?.trim() || docList[idx].title,
        content: opts.activeBody,
      }
    }
    else {
      docList.push({
        path: opts.activePath,
        kind: opts.activePath.startsWith('src/content/about/') ? 'about' : 'post',
        title: opts.activeTitle?.trim() || opts.activePath.split('/').pop() || opts.activePath,
        content: opts.activeBody,
      })
    }
  }

  const parsedDocs = docList.map(doc => ({
    doc,
    extracted: extractResolvedImagePaths(doc.path, doc.content),
  }))

  const refsByRepoPath = new Map<string, MediaDocRef[]>()
  for (const item of opts.items) {
    const refs: MediaDocRef[] = []
    for (const { doc, extracted } of parsedDocs) {
      if (docReferencesMedia(doc.content, extracted, item)) {
        refs.push({
          path: doc.path,
          kind: doc.kind,
          title: doc.title,
        })
      }
    }
    refsByRepoPath.set(item.repoPath, refs)
  }

  // Cluster by content hash (Git blob SHA-1) to detect exact duplicates
  const itemsByHash = new Map<string, AdminMediaItem[]>()
  for (const item of opts.items) {
    if (!item.hash) {
      continue
    }
    const list = itemsByHash.get(item.hash) || []
    list.push(item)
    itemsByHash.set(item.hash, list)
  }

  const duplicateGroups: DuplicateGroupReport[] = []
  const dupMetaByPath = new Map<string, {
    groupId: number
    peers: string[]
    isCanonical: boolean
  }>()

  let nextGroupId = 1
  for (const [hash, groupItems] of itemsByHash.entries()) {
    if (groupItems.length < 2) {
      continue
    }
    const groupId = nextGroupId
    nextGroupId += 1

    const sorted = [...groupItems].sort((a, b) => {
      const aRefs = refsByRepoPath.get(a.repoPath)?.length ?? 0
      const bRefs = refsByRepoPath.get(b.repoPath)?.length ?? 0
      if (aRefs !== bRefs) {
        return bRefs - aRefs
      }
      if (Boolean(a.pending) !== Boolean(b.pending)) {
        return a.pending ? 1 : -1
      }
      const aActive = refsByRepoPath.get(a.repoPath)?.some(r => r.path === opts.activePath) ? 1 : 0
      const bActive = refsByRepoPath.get(b.repoPath)?.some(r => r.path === opts.activePath) ? 1 : 0
      if (aActive !== bActive) {
        return bActive - aActive
      }
      return a.filename.localeCompare(b.filename)
    })

    const canonical = sorted[0]
    const redundant = sorted.slice(1)
    const safeUnusedRedundant = redundant.filter(item => (refsByRepoPath.get(item.repoPath)?.length ?? 0) === 0)
    const allPaths = sorted.map(i => i.repoPath)

    for (const item of sorted) {
      dupMetaByPath.set(item.repoPath, {
        groupId,
        peers: allPaths.filter(p => p !== item.repoPath),
        isCanonical: item.repoPath === canonical.repoPath,
      })
    }

    duplicateGroups.push({
      groupId,
      hash,
      canonicalPath: canonical.repoPath,
      redundantPaths: redundant.map(r => r.repoPath),
      safeUnusedRedundantPaths: safeUnusedRedundant.map(r => r.repoPath),
      itemPaths: allPaths,
      reclaimableBytes: safeUnusedRedundant.reduce((sum, r) => sum + r.size, 0),
    })
  }

  const byPath = new Map<string, AuditedMediaInfo>()
  const globallyUnusedPaths: string[] = []
  let globallyUnusedBytes = 0
  const safeDuplicateDeletablePaths: string[] = []
  let safeDuplicateReclaimBytes = 0
  let totalBytes = 0
  let pendingCount = 0

  for (const item of opts.items) {
    totalBytes += item.size
    if (item.pending) {
      pendingCount += 1
    }
    const refs = refsByRepoPath.get(item.repoPath) || []
    const usedInActivePost = Boolean(opts.activePath && refs.some(r => r.path === opts.activePath))
    const usedGlobally = refs.length > 0
    if (!usedGlobally) {
      globallyUnusedPaths.push(item.repoPath)
      globallyUnusedBytes += item.size
    }

    const dup = dupMetaByPath.get(item.repoPath)
    const isDupCopy = Boolean(dup && !dup.isCanonical)
    const safeDuplicateDeletable = Boolean(isDupCopy && !usedGlobally)
    if (safeDuplicateDeletable) {
      safeDuplicateDeletablePaths.push(item.repoPath)
      safeDuplicateReclaimBytes += item.size
    }

    byPath.set(item.repoPath, {
      repoPath: item.repoPath,
      refs,
      usedInActivePost,
      usedGlobally,
      duplicateGroupId: dup?.groupId ?? null,
      duplicatePeers: dup?.peers ?? [],
      isCanonicalInGroup: dup ? dup.isCanonical : true,
      safeDuplicateDeletable,
    })
  }

  return {
    byPath,
    duplicateGroups,
    totalCount: opts.items.length,
    totalBytes,
    pendingCount,
    globallyUnusedPaths,
    globallyUnusedBytes,
    safeDuplicateDeletablePaths,
    safeDuplicateReclaimBytes,
  }
}

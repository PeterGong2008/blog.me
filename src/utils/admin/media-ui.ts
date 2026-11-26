import type { GlobalMediaAuditResult } from './media-audit'
import type { AdminDocContent, AdminMediaItem, StorageAdapter } from './storage'
import { computeRelativeImagePath } from './frontmatter'
import { auditMediaLibrary } from './media-audit'

export type ImageTier = 'standard' | 'wide' | 'compact'

export interface MarkdownImageToken {
  index: number
  start: number
  end: number
  rawAlt: string
  cleanAlt: string
  hiddenCaption: boolean
  src: string
  tier: ImageTier
}

export function maskProtectedMarkdownSpans(rawBody: string): string {
  const maskMatch = (match: string) => match.replace(/[^\r\n]/g, ' ')
  let masked = rawBody.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, maskMatch)
  masked = masked.replace(
    /^:::(?:grid|gallery)(?:\[[^\]]*\])?(?:\{[^}]*\})?[ \t]*\r?\n[\s\S]*?\r?\n:::[ \t]*$/gm,
    maskMatch,
  )
  masked = masked.replace(/`[^`\n]+`/g, maskMatch)
  return masked
}

export function normalizeImageTier(rawTitle: string | null | undefined): ImageTier {
  const cleaned = (rawTitle || '').trim().toLowerCase()
  if (cleaned === 'wide' || cleaned === 'compact') {
    return cleaned
  }
  return 'standard'
}

export function findMarkdownImages(rawBody: string): MarkdownImageToken[] {
  const masked = maskProtectedMarkdownSpans(rawBody)
  const regex = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g
  const tokens: MarkdownImageToken[] = []

  let match = regex.exec(masked)
  while (match !== null) {
    const start = match.index
    const end = start + match[0].length
    const rawAlt = rawBody.slice(start + 2, start + 2 + match[1].length)
    const hiddenCaption = rawAlt.startsWith('_')
    const cleanAlt = hiddenCaption ? rawAlt.slice(1) : rawAlt
    const src = match[2]
    const tier = normalizeImageTier(match[3])

    tokens.push({
      index: tokens.length,
      start,
      end,
      rawAlt,
      cleanAlt,
      hiddenCaption,
      src,
      tier,
    })
    match = regex.exec(masked)
  }

  return tokens
}

export function buildMarkdownImageSyntax(opts: {
  cleanAlt: string
  hiddenCaption: boolean
  src: string
  tier: ImageTier
}): string {
  const safeAlt = opts.cleanAlt.replace(/\]/g, '')
  const altPart = opts.hiddenCaption ? `_${safeAlt}` : safeAlt
  const titlePart = opts.tier === 'standard' ? '' : ` "${opts.tier}"`
  return `![${altPart}](${opts.src}${titlePart})`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function qs<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) {
    throw new Error(`Missing admin media element #${id}`)
  }
  return el as T
}

export interface LibraryUploadSummary {
  repoPaths: string[]
  newCount: number
  duplicateMatches: Array<{ fileName: string, existingName: string, repoPath: string }>
}

export interface AdminMediaUIOptions {
  getAdapter: () => StorageAdapter | null
  getActivePath: () => string | null
  getActiveTitle: () => string
  getBody: () => string
  getDraftDocs: () => AdminDocContent[]
  applyBodyChange: (nextBody: string, opts?: { selectRange?: [number, number] }) => void
  insertAtCursor: (text: string) => void
  onUploadToLibrary: (files: FileList | File[]) => Promise<LibraryUploadSummary>
  onMediaChanged?: () => void
  askConfirm: (title: string, desc: string, confirmText?: string) => Promise<boolean>
  showToast: (message: string, tone?: 'info' | 'success' | 'error') => void
  bodyTextarea: HTMLTextAreaElement
  previewPaneEl: HTMLElement
  previewBodyEl: HTMLElement
}

export interface AdminMediaUIHandle {
  openMediaLibrary: (opts?: { preselectPaths?: string[], auditNote?: string }) => Promise<void>
  closeInspector: () => void
  refreshIfOpen: () => Promise<void>
}

export function initAdminMediaUI(options: AdminMediaUIOptions): AdminMediaUIHandle {
  // Media Library Modal DOM
  const mediaModalEl = qs<HTMLElement>('modal-media-library')
  const mediaPanelEl = qs<HTMLElement>('media-library-panel')
  const mediaSummaryEl = qs<HTMLElement>('media-library-summary')
  const mediaVerifyDedupBtn = qs<HTMLButtonElement>('btn-media-verify-dedup')
  const mediaCommitPendingBtn = qs<HTMLButtonElement>('btn-media-commit-pending')
  const mediaCloseBtn = qs<HTMLButtonElement>('btn-media-close')
  const mediaUploadBtn = qs<HTMLButtonElement>('btn-media-upload')
  const mediaUploadInput = qs<HTMLInputElement>('input-media-upload')
  const mediaSearchInput = qs<HTMLInputElement>('media-search-input')
  const mediaFilterBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-media-filter]'))
  const mediaAuditBannerEl = qs<HTMLElement>('media-audit-banner')
  const mediaAuditTextEl = qs<HTMLElement>('media-audit-text')
  const selectDupCopiesBtn = qs<HTMLButtonElement>('btn-select-dup-copies')
  const selectUnusedBtn = qs<HTMLButtonElement>('btn-select-unused')
  const mediaGridEl = qs<HTMLElement>('media-library-grid')
  const mediaEmptyEl = qs<HTMLElement>('media-library-empty')
  const mediaSelectionHintEl = qs<HTMLElement>('media-selection-hint')
  const mediaSingleActionsEl = qs<HTMLElement>('media-single-actions')
  const mediaMultiActionsEl = qs<HTMLElement>('media-multi-actions')
  const mediaGroupTitleInput = qs<HTMLInputElement>('media-group-title')
  const mediaDeleteSelectedBtn = qs<HTMLButtonElement>('btn-media-delete-selected')
  const mediaClearSelectionBtn = qs<HTMLButtonElement>('btn-media-clear')
  const mediaSingleBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-media-insert-tier]'))
  const mediaMultiBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-media-insert-group]'))

  // Image Inspector Popover DOM
  const inspectorEl = qs<HTMLElement>('image-inspector')
  const inspectorCloseBtn = qs<HTMLButtonElement>('btn-inspector-close')
  const inspectorAltInput = qs<HTMLInputElement>('inspector-alt')
  const inspectorHideCheck = qs<HTMLInputElement>('inspector-hide-caption')
  const inspectorTierBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-inspector-tier]'))
  const inspectorLocateBtn = qs<HTMLButtonElement>('btn-inspector-locate')
  const inspectorRemoveBtn = qs<HTMLButtonElement>('btn-inspector-remove')

  type MediaFilterKind = 'all' | 'global-used' | 'used' | 'unused' | 'duplicate'
  let mediaItems: AdminMediaItem[] = []
  let cachedDocs: AdminDocContent[] = []
  let auditResult: GlobalMediaAuditResult | null = null
  let mediaFilter: MediaFilterKind = 'all'
  let mediaSearch = ''
  let selectedPaths: string[] = []
  let explicitAuditNote = ''
  let showCleanAuditBanner = false
  let activeInspectIdx: number | null = null

  function recomputeAudit(): GlobalMediaAuditResult {
    const draftDocs = options.getDraftDocs()
    const mergedDocs = [...cachedDocs]
    for (const draft of draftDocs) {
      const idx = mergedDocs.findIndex(d => d.path === draft.path)
      if (idx >= 0) {
        mergedDocs[idx] = draft
      }
      else {
        mergedDocs.push(draft)
      }
    }
    const result = auditMediaLibrary({
      items: mediaItems,
      docs: mergedDocs,
      activePath: options.getActivePath(),
      activeTitle: options.getActiveTitle(),
      activeBody: options.getBody(),
    })
    auditResult = result
    return result
  }

  function isItemDeletable(item: AdminMediaItem): boolean {
    if (item.pending) {
      return true
    }
    const info = auditResult?.byPath.get(item.repoPath)
    return !info?.usedGlobally
  }

  function updateSummaryAndBanner(result: GlobalMediaAuditResult): void {
    const hasActive = Boolean(options.getActivePath())
    const dupSummary = result.duplicateGroups.length > 0
      ? ` · 内容重复 ${result.duplicateGroups.length} 组`
      : ' · 无重复'
    mediaSummaryEl.textContent = `共 ${result.totalCount} 张 · ${formatFileSize(result.totalBytes)} · 全局未用 ${result.globallyUnusedPaths.length} 张${dupSummary}`

    const adapter = options.getAdapter()
    const showCommitPending = Boolean(adapter?.mode === 'github' && adapter.commitPendingUploads && result.pendingCount > 0)
    mediaCommitPendingBtn.classList.toggle('hidden', !showCommitPending)
    if (showCommitPending) {
      mediaCommitPendingBtn.textContent = `提交新增 (${result.pendingCount})`
    }

    let globalUsedCount = 0
    let activeUsedCount = 0
    let duplicateItemCount = 0
    for (const info of result.byPath.values()) {
      if (info.usedGlobally) {
        globalUsedCount += 1
      }
      if (info.usedInActivePost) {
        activeUsedCount += 1
      }
      if (info.duplicateGroupId !== null) {
        duplicateItemCount += 1
      }
    }

    for (const btn of mediaFilterBtns) {
      const key = btn.dataset.mediaFilter as MediaFilterKind
      if (key === 'used') {
        btn.classList.toggle('hidden', !hasActive)
      }
      switch (key) {
        case 'all':
          btn.textContent = `全部 (${result.totalCount})`
          break
        case 'global-used':
          btn.textContent = `全局已用 (${globalUsedCount})`
          break
        case 'used':
          btn.textContent = `本文已用 (${activeUsedCount})`
          break
        case 'unused':
          btn.textContent = `全局未用 (${result.globallyUnusedPaths.length})`
          break
        case 'duplicate':
          btn.textContent = `重复图片 (${duplicateItemCount})`
          break
      }
    }
    if (!hasActive && mediaFilter === 'used') {
      setMediaFilter('all')
    }

    const dupCopyCount = result.safeDuplicateDeletablePaths.length
    const unusedCount = result.globallyUnusedPaths.length
    selectDupCopiesBtn.classList.toggle('hidden', dupCopyCount === 0)
    if (dupCopyCount > 0) {
      selectDupCopiesBtn.textContent = `选中多余副本 (${dupCopyCount})`
    }
    selectUnusedBtn.classList.toggle('hidden', unusedCount === 0)
    if (unusedCount > 0) {
      selectUnusedBtn.textContent = `选中全局未用 (${unusedCount})`
    }

    if (explicitAuditNote) {
      mediaAuditTextEl.textContent = explicitAuditNote
      mediaAuditBannerEl.classList.remove('hidden')
      mediaAuditBannerEl.classList.add('flex')
      return
    }

    if (result.duplicateGroups.length > 0) {
      const copyPart = dupCopyCount > 0
        ? `，其中 ${dupCopyCount} 张未被引用可安全删除（可释放 ${formatFileSize(result.safeDuplicateReclaimBytes)}）`
        : '（均已被文章引用，暂保留全部关联文件）'
      mediaAuditTextEl.textContent = `内容去重提示：发现 ${result.duplicateGroups.length} 组 SHA-1 完全一致的重复图片${copyPart}`
      mediaAuditBannerEl.classList.remove('hidden')
      mediaAuditBannerEl.classList.add('flex')
      return
    }

    if (showCleanAuditBanner || unusedCount > 0) {
      mediaAuditTextEl.textContent = showCleanAuditBanner
        ? `✓ 去重校验通过：全库 ${result.totalCount} 张素材（${formatFileSize(result.totalBytes)}）SHA-1 内容哈希均唯一，无重复文件`
        : `可清理提示：全库有 ${unusedCount} 张图片未被任何文章引用（共 ${formatFileSize(result.globallyUnusedBytes)}）`
      mediaAuditBannerEl.classList.remove('hidden')
      mediaAuditBannerEl.classList.add('flex')
      return
    }

    mediaAuditBannerEl.classList.add('hidden')
    mediaAuditBannerEl.classList.remove('flex')
  }

  function updateMediaActionBar(): void {
    const count = selectedPaths.length
    const hasActivePost = Boolean(options.getActivePath())
    mediaClearSelectionBtn.classList.toggle('hidden', count === 0)

    const selectedItems = selectedPaths
      .map(p => mediaItems.find(m => m.repoPath === p))
      .filter((m): m is AdminMediaItem => Boolean(m))
    const deletableCount = selectedItems.filter(isItemDeletable).length
    const blockedCount = selectedItems.length - deletableCount

    if (count === 0) {
      mediaDeleteSelectedBtn.classList.add('hidden')
      mediaDeleteSelectedBtn.disabled = false
    }
    else if (deletableCount > 0) {
      mediaDeleteSelectedBtn.classList.remove('hidden')
      mediaDeleteSelectedBtn.disabled = false
      mediaDeleteSelectedBtn.textContent = blockedCount > 0
        ? `删除其中未用 (${deletableCount})`
        : `删除所选 (${deletableCount})`
      mediaDeleteSelectedBtn.title = blockedCount > 0
        ? `有 ${blockedCount} 张图片正在被文章引用，将跳过保护并仅删除 ${deletableCount} 张未引用图片`
        : '永久删除选中的未引用图片（pending 图片将从暂存撤销）'
    }
    else {
      mediaDeleteSelectedBtn.classList.remove('hidden')
      mediaDeleteSelectedBtn.disabled = true
      mediaDeleteSelectedBtn.textContent = `所选均已引用 (${blockedCount})`
      mediaDeleteSelectedBtn.title = '被文章引用的图片不可直接删除，请先从文章移除引用'
    }

    if (count === 0) {
      mediaSelectionHintEl.textContent = hasActivePost
        ? '点选图片按需插入当前文章，或勾选全局未用 / 多余副本图片批量删除'
        : '点选图片可批量删除未用素材或验证去重；打开任意文章后可直接选图插入正文'
      mediaSelectionHintEl.classList.remove('hidden')
      mediaSingleActionsEl.classList.add('hidden')
      mediaSingleActionsEl.classList.remove('flex')
      mediaMultiActionsEl.classList.add('hidden')
      mediaMultiActionsEl.classList.remove('flex')
      return
    }

    if (!hasActivePost) {
      mediaSelectionHintEl.textContent = `已选 ${count} 张图片（当前未打开文章，可使用右侧管理操作或关闭后打开文章插入）`
      mediaSelectionHintEl.classList.remove('hidden')
      mediaSingleActionsEl.classList.add('hidden')
      mediaSingleActionsEl.classList.remove('flex')
      mediaMultiActionsEl.classList.add('hidden')
      mediaMultiActionsEl.classList.remove('flex')
      return
    }

    if (count === 1) {
      mediaSelectionHintEl.textContent = '已选 1 张图片：选择排版档位插入当前文章'
      mediaSelectionHintEl.classList.remove('hidden')
      mediaSingleActionsEl.classList.remove('hidden')
      mediaSingleActionsEl.classList.add('flex')
      mediaMultiActionsEl.classList.add('hidden')
      mediaMultiActionsEl.classList.remove('flex')
      return
    }

    mediaSelectionHintEl.classList.add('hidden')
    mediaSingleActionsEl.classList.add('hidden')
    mediaSingleActionsEl.classList.remove('flex')
    mediaMultiActionsEl.classList.remove('hidden')
    mediaMultiActionsEl.classList.add('flex')
  }

  function renderMediaGrid(): void {
    const result = recomputeAudit()
    updateSummaryAndBanner(result)

    const query = mediaSearch.trim().toLowerCase()
    const filtered = mediaItems.filter((item) => {
      const info = result.byPath.get(item.repoPath)
      const usedInActive = Boolean(info?.usedInActivePost)
      const usedGlobally = Boolean(info?.usedGlobally)
      const isDuplicate = info?.duplicateGroupId !== null && info?.duplicateGroupId !== undefined

      if (mediaFilter === 'global-used' && !usedGlobally) {
        return false
      }
      if (mediaFilter === 'used' && !usedInActive) {
        return false
      }
      if (mediaFilter === 'unused' && usedGlobally) {
        return false
      }
      if (mediaFilter === 'duplicate' && !isDuplicate) {
        return false
      }
      if (query) {
        const refText = info?.refs.map(r => r.title).join(' ').toLowerCase() || ''
        if (
          !item.filename.toLowerCase().includes(query)
          && !item.repoPath.toLowerCase().includes(query)
          && !refText.includes(query)
        ) {
          return false
        }
      }
      return true
    })

    if (filtered.length === 0) {
      mediaGridEl.innerHTML = ''
      mediaEmptyEl.classList.remove('hidden')
      updateMediaActionBar()
      return
    }

    mediaEmptyEl.classList.add('hidden')
    mediaGridEl.innerHTML = filtered.map((item) => {
      const selIdx = selectedPaths.indexOf(item.repoPath)
      const isSelected = selIdx >= 0
      const info = result.byPath.get(item.repoPath)
      const usedGlobally = Boolean(info?.usedGlobally)
      const usedInActive = Boolean(info?.usedInActivePost)
      const refTitles = info?.refs.map(r => `《${r.title}》`).join('、') || ''

      const badgeClass = item.pending
        ? 'media-pill media-pill-pending'
        : usedInActive
          ? 'media-pill media-pill-active'
          : usedGlobally
            ? 'media-pill media-pill-global'
            : 'media-pill media-pill-unused'
      const badgeLabel = item.pending
        ? '待提交'
        : usedInActive
          ? '本文已用'
          : usedGlobally
            ? `引用 ${info?.refs.length ?? 1} 篇`
            : '全局未用'
      const badgeTitle = refTitles ? `引用文章：${refTitles}` : '未被任何文章引用'

      const canDelete = isItemDeletable(item)
      const cardClass = isSelected ? 'media-card is-selected' : 'media-card'

      let subInfoHtml = formatFileSize(item.size)
      if (item.hash) {
        subInfoHtml += ` · #${item.hash.slice(0, 7)}`
      }

      let statusDetailHtml = ''
      if (info && info.duplicateGroupId !== null) {
        const dupTag = info.isCanonicalInGroup
          ? `重复组 #${info.duplicateGroupId} · 保留主图`
          : `重复组 #${info.duplicateGroupId} · ${usedGlobally ? '重复副本(有引用)' : '多余副本(可删)'}`
        const dupClass = info.isCanonicalInGroup ? 'is-dup-main' : 'is-dup-copy'
        statusDetailHtml = `<div class="media-card-sub ${dupClass}" title="${escapeHtml(refTitles || dupTag)}">${escapeHtml(dupTag)}</div>`
      }
      else if (refTitles) {
        statusDetailHtml = `<div class="media-card-sub" title="${escapeHtml(refTitles)}">引用：${escapeHtml(refTitles)}</div>`
      }
      else {
        statusDetailHtml = `<div class="media-card-sub is-unused">未被任何文章引用</div>`
      }

      return `<div data-media-card="${escapeHtml(item.repoPath)}" class="${cardClass}">
        <div class="media-card-thumb">
          <img
            data-media-repo="${escapeHtml(item.repoPath)}"
            src="${escapeHtml(item.previewUrl)}"
            alt="${escapeHtml(item.filename)}"
            loading="lazy"
          />
          <span class="media-card-badge">
            ${isSelected ? `#${selIdx + 1}` : '选择'}
          </span>
          ${canDelete
            ? `<button type="button" data-delete-media="${escapeHtml(item.repoPath)}" class="media-card-delete" title="${item.pending ? '撤销暂存的待提交图片' : '永久删除未引用的图片文件'}">${item.pending ? '撤销' : '删除'}</button>`
            : ''}
        </div>
        <div class="media-card-head">
          <span class="media-card-name" title="${escapeHtml(item.repoPath)}">${escapeHtml(item.filename)}</span>
          <span class="${badgeClass}" title="${escapeHtml(badgeTitle)}">${badgeLabel}</span>
        </div>
        <div class="media-card-meta">${subInfoHtml}</div>
        ${statusDetailHtml}
      </div>`
    }).join('')

    updateMediaActionBar()
    void hydrateMediaThumbnails()
  }

  async function hydrateMediaThumbnails(): Promise<void> {
    const adapter = options.getAdapter()
    const activePath = options.getActivePath() || 'src/content/posts/placeholder.md'
    if (!adapter) {
      return
    }
    const imgs = Array.from(mediaGridEl.querySelectorAll<HTMLImageElement>('img[data-media-repo]'))
    await Promise.all(
      imgs.map(async (img) => {
        if (img.getAttribute('src')) {
          return
        }
        const repoPath = img.dataset.mediaRepo
        if (!repoPath) {
          return
        }
        const resolved = await adapter.resolveImagePreviewUrl(repoPath, activePath)
        if (resolved) {
          img.src = resolved
        }
      }),
    )
  }

  function setMediaFilter(nextFilter: MediaFilterKind): void {
    mediaFilter = nextFilter
    for (const b of mediaFilterBtns) {
      const active = (b.dataset.mediaFilter || 'all') === nextFilter
      b.classList.toggle('bg-highlight', active)
      b.classList.toggle('c-primary', active)
      b.classList.toggle('font-medium', active)
    }
  }

  async function loadAndShowMediaLibrary(opts?: { preselectPaths?: string[], auditNote?: string }): Promise<void> {
    const adapter = options.getAdapter()
    if (!adapter) {
      return
    }
    if (opts?.auditNote !== undefined) {
      explicitAuditNote = opts.auditNote
    }
    else {
      explicitAuditNote = ''
    }

    if (opts?.preselectPaths && opts.preselectPaths.length > 0) {
      if (mediaFilter !== 'all') {
        setMediaFilter('all')
      }
      if (mediaSearch) {
        mediaSearch = ''
        mediaSearchInput.value = ''
      }
      for (const p of opts.preselectPaths) {
        if (!selectedPaths.includes(p)) {
          selectedPaths.push(p)
        }
      }
    }

    mediaModalEl.classList.remove('hidden')
    mediaModalEl.classList.add('flex')
    mediaGridEl.innerHTML = '<div class="col-span-full py-10 text-center text-xs c-secondary/70">正在扫描全站素材与引用...</div>'
    mediaEmptyEl.classList.add('hidden')

    try {
      const [items, docs] = await Promise.all([
        adapter.listMedia(),
        adapter.listDocumentContents ? adapter.listDocumentContents() : Promise.resolve([]),
      ])
      mediaItems = items
      cachedDocs = docs
      selectedPaths = selectedPaths.filter(p => mediaItems.some(m => m.repoPath === p))
      renderMediaGrid()
    }
    catch (err) {
      mediaGridEl.innerHTML = ''
      options.showToast(err instanceof Error ? err.message : '加载素材库失败', 'error')
    }
  }

  function closeMediaLibrary(): void {
    mediaModalEl.classList.add('hidden')
    mediaModalEl.classList.remove('flex')
  }

  function insertSelectedSingle(tier: ImageTier): void {
    const activePath = options.getActivePath()
    if (!activePath) {
      options.showToast('请先在左侧打开或新建一篇文章再插入图片', 'info')
      return
    }
    if (selectedPaths.length !== 1) {
      return
    }
    const repoPath = selectedPaths[0]
    const item = mediaItems.find(m => m.repoPath === repoPath)
    const cleanAlt = (item?.filename || '图片').replace(/\.[^.]+$/, '')
    const relPath = computeRelativeImagePath(activePath, repoPath)
    const snippet = `${buildMarkdownImageSyntax({
      cleanAlt: tier === 'compact' ? `要点说明 | ${cleanAlt}` : cleanAlt,
      hiddenCaption: false,
      src: relPath,
      tier,
    })}\n`

    options.insertAtCursor(snippet)
    selectedPaths = []
    closeMediaLibrary()
    options.showToast('已插入图片到正文', 'success')
  }

  function insertSelectedGroup(mode: 'grid-auto' | 'grid-2' | 'grid-3' | 'stage'): void {
    const activePath = options.getActivePath()
    if (!activePath) {
      options.showToast('请先在左侧打开或新建一篇文章再插入图片', 'info')
      return
    }
    if (selectedPaths.length < 2) {
      return
    }
    const title = mediaGroupTitleInput.value.trim()
    const titleSuffix = title ? `[${title}]` : ''
    const lines = selectedPaths.map((repoPath) => {
      const item = mediaItems.find(m => m.repoPath === repoPath)
      const cleanAlt = (item?.filename || '图片').replace(/\.[^.]+$/, '')
      const relPath = computeRelativeImagePath(activePath, repoPath)
      return `![${cleanAlt}](${relPath})`
    })

    let header = ':::gallery'
    if (mode === 'stage') {
      header = `:::gallery${titleSuffix}`
    }
    else if (mode === 'grid-2') {
      header = `:::grid${titleSuffix}{cols="2"}`
    }
    else if (mode === 'grid-3') {
      header = `:::grid${titleSuffix}{cols="3"}`
    }
    else {
      header = `:::grid${titleSuffix}`
    }

    const snippet = `\n${header}\n${lines.join('\n')}\n:::\n`
    options.insertAtCursor(snippet)
    selectedPaths = []
    mediaGroupTitleInput.value = ''
    closeMediaLibrary()
    options.showToast(mode === 'stage' ? '已插入舞台画廊' : '已插入多宫格图集', 'success')
  }

  // Image Inspector Popover logic
  function closeInspector(): void {
    inspectorEl.classList.add('hidden')
    activeInspectIdx = null
  }

  function setInspectorTierUI(activeTier: ImageTier): void {
    for (const btn of inspectorTierBtns) {
      const isMatch = btn.dataset.inspectorTier === activeTier
      btn.classList.toggle('bg-highlight', isMatch)
      btn.classList.toggle('c-primary', isMatch)
      btn.classList.toggle('font-medium', isMatch)
    }
  }

  function openInspectorForImage(imgEl: HTMLElement, tokenIdx: number): void {
    const tokens = findMarkdownImages(options.getBody())
    const token = tokens[tokenIdx]
    if (!token) {
      return
    }

    activeInspectIdx = tokenIdx
    inspectorAltInput.value = token.cleanAlt
    inspectorHideCheck.checked = token.hiddenCaption
    setInspectorTierUI(token.tier)

    inspectorEl.classList.remove('hidden')
    const imgRect = imgEl.getBoundingClientRect()
    const popRect = inspectorEl.getBoundingClientRect()
    const desiredLeft = Math.max(12, Math.min(imgRect.left, window.innerWidth - popRect.width - 12))
    let desiredTop = imgRect.bottom + 8
    if (desiredTop + popRect.height > window.innerHeight - 12) {
      desiredTop = Math.max(12, imgRect.top - popRect.height - 8)
    }
    inspectorEl.style.left = `${desiredLeft}px`
    inspectorEl.style.top = `${desiredTop}px`
  }

  function applyInspectorChanges(newTier?: ImageTier): void {
    if (activeInspectIdx === null) {
      return
    }
    const body = options.getBody()
    const tokens = findMarkdownImages(body)
    const token = tokens[activeInspectIdx]
    if (!token) {
      closeInspector()
      return
    }

    const tier = newTier ?? (inspectorTierBtns.find(b => b.classList.contains('bg-highlight'))?.dataset.inspectorTier as ImageTier || 'standard')
    if (newTier) {
      setInspectorTierUI(newTier)
    }

    const nextSyntax = buildMarkdownImageSyntax({
      cleanAlt: inspectorAltInput.value,
      hiddenCaption: inspectorHideCheck.checked,
      src: token.src,
      tier,
    })

    const nextBody = `${body.slice(0, token.start)}${nextSyntax}${body.slice(token.end)}`
    options.applyBodyChange(nextBody)
  }

  // Event listeners for Media Library
  mediaCloseBtn.addEventListener('click', () => closeMediaLibrary())
  mediaModalEl.addEventListener('click', (ev) => {
    if (ev.target === mediaModalEl) {
      closeMediaLibrary()
    }
  })

  mediaSearchInput.addEventListener('input', () => {
    mediaSearch = mediaSearchInput.value
    renderMediaGrid()
  })

  async function deletePathsWithConfirm(targetPaths: string[]): Promise<void> {
    const targets = targetPaths
      .map(p => mediaItems.find(m => m.repoPath === p))
      .filter((m): m is AdminMediaItem => Boolean(m))
      .filter(isItemDeletable)

    if (targets.length === 0) {
      options.showToast('所选图片均正在被文章引用，无法删除', 'info')
      return
    }

    const adapter = options.getAdapter()
    if (!adapter) {
      return
    }

    const pendingTargets = targets.filter(t => t.pending)
    const savedTargets = targets.filter(t => !t.pending)
    const isGitHub = adapter.mode === 'github'

    let title = '删除图片资源'
    let desc = ''
    let confirmLabel = '确认删除'

    if (targets.length === 1 && pendingTargets.length === 1) {
      title = '撤销待提交图片'
      desc = `确定从暂存队列移除「${pendingTargets[0].filename}」吗？尚未提交到 GitHub。`
      confirmLabel = '确认撤销'
    }
    else if (targets.length === 1) {
      desc = `确定永久删除未引用图片「${targets[0].repoPath}」吗？此操作无法撤销。`
    }
    else {
      title = '批量删除未引用图片'
      desc = `确定删除选中的 ${targets.length} 张未引用图片吗？${
        savedTargets.length > 0 && isGitHub
          ? `（其中 ${savedTargets.length} 张远端文件将通过 1 次 GitHub 提交批量清理）`
          : '此操作无法撤销。'
      }`
    }

    const ok = await options.askConfirm(title, desc, confirmLabel)
    if (!ok) {
      return
    }

    const prevDeleteDisabled = mediaDeleteSelectedBtn.disabled
    mediaDeleteSelectedBtn.disabled = true
    try {
      const repoList = targets.map(t => t.repoPath)
      if (repoList.length > 1 && adapter.deleteMediaBatch) {
        await adapter.deleteMediaBatch(repoList)
      }
      else if (adapter.deleteMediaBatch && repoList.length === 1) {
        await adapter.deleteMediaBatch(repoList)
      }
      else {
        for (const p of repoList) {
          await adapter.deleteMedia(p)
        }
      }

      const deletedSet = new Set(repoList)
      selectedPaths = selectedPaths.filter(p => !deletedSet.has(p))
      mediaItems = mediaItems.filter(m => !deletedSet.has(m.repoPath))
      explicitAuditNote = `已清理 ${targets.length} 张素材（${savedTargets.length > 0 && isGitHub ? '已同步至 GitHub 仓库' : '已安全删除'}）`
      renderMediaGrid()
      options.onMediaChanged?.()
      options.showToast(
        targets.length === 1 && pendingTargets.length === 1
          ? '已撤销该暂存图片'
          : `已删除 ${targets.length} 张图片`,
        'success',
      )
    }
    catch (err) {
      options.showToast(err instanceof Error ? err.message : '删除图片失败', 'error')
    }
    finally {
      mediaDeleteSelectedBtn.disabled = prevDeleteDisabled
      updateMediaActionBar()
    }
  }

  for (const btn of mediaFilterBtns) {
    btn.addEventListener('click', () => {
      const next = (btn.dataset.mediaFilter as MediaFilterKind) || 'all'
      setMediaFilter(next)
      renderMediaGrid()
    })
  }

  mediaVerifyDedupBtn.addEventListener('click', async () => {
    showCleanAuditBanner = true
    explicitAuditNote = ''
    await loadAndShowMediaLibrary()
    if (auditResult) {
      if (auditResult.duplicateGroups.length > 0) {
        setMediaFilter('duplicate')
        renderMediaGrid()
        options.showToast(`校验完成：发现 ${auditResult.duplicateGroups.length} 组内容重复图片`, 'info')
      }
      else {
        options.showToast(`校验完成：${auditResult.totalCount} 张素材哈希均唯一，无重复`, 'success')
      }
    }
  })

  mediaCommitPendingBtn.addEventListener('click', async () => {
    const adapter = options.getAdapter()
    if (!adapter?.commitPendingUploads) {
      return
    }
    const pendingCount = adapter.getPendingUploadCount?.() ?? 0
    if (pendingCount === 0) {
      return
    }
    mediaCommitPendingBtn.disabled = true
    mediaCommitPendingBtn.textContent = '提交中...'
    try {
      const committed = await adapter.commitPendingUploads()
      explicitAuditNote = `已将 ${committed} 张新增图片直接提交到 GitHub 仓库`
      options.onMediaChanged?.()
      await loadAndShowMediaLibrary({ auditNote: explicitAuditNote })
      options.showToast(`已提交 ${committed} 张图片到 GitHub`, 'success')
    }
    catch (err) {
      options.showToast(err instanceof Error ? err.message : '提交新增素材失败', 'error')
    }
    finally {
      mediaCommitPendingBtn.disabled = false
    }
  })

  selectDupCopiesBtn.addEventListener('click', () => {
    if (!auditResult || auditResult.safeDuplicateDeletablePaths.length === 0) {
      return
    }
    selectedPaths = [...auditResult.safeDuplicateDeletablePaths]
    if (mediaFilter !== 'duplicate' && mediaFilter !== 'all') {
      setMediaFilter('duplicate')
    }
    renderMediaGrid()
    options.showToast(`已选中 ${selectedPaths.length} 张未引用的多余重复副本`, 'info')
  })

  selectUnusedBtn.addEventListener('click', () => {
    if (!auditResult || auditResult.globallyUnusedPaths.length === 0) {
      return
    }
    selectedPaths = [...auditResult.globallyUnusedPaths]
    if (mediaFilter !== 'unused' && mediaFilter !== 'all') {
      setMediaFilter('unused')
    }
    renderMediaGrid()
    options.showToast(`已选中 ${selectedPaths.length} 张全局未引用图片`, 'info')
  })

  mediaDeleteSelectedBtn.addEventListener('click', () => {
    if (selectedPaths.length > 0) {
      void deletePathsWithConfirm([...selectedPaths])
    }
  })

  mediaGridEl.addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement
    const delBtn = target.closest<HTMLElement>('[data-delete-media]')
    if (delBtn) {
      ev.stopPropagation()
      const repoPath = delBtn.dataset.deleteMedia
      if (repoPath) {
        await deletePathsWithConfirm([repoPath])
      }
      return
    }

    const card = target.closest<HTMLElement>('[data-media-card]')
    const repoPath = card?.dataset.mediaCard
    if (!repoPath) {
      return
    }
    const existingIdx = selectedPaths.indexOf(repoPath)
    if (existingIdx >= 0) {
      selectedPaths.splice(existingIdx, 1)
    }
    else {
      selectedPaths.push(repoPath)
    }
    renderMediaGrid()
  })

  mediaClearSelectionBtn.addEventListener('click', () => {
    selectedPaths = []
    renderMediaGrid()
  })

  for (const btn of mediaSingleBtns) {
    btn.addEventListener('click', () => {
      const tier = (btn.dataset.mediaInsertTier as ImageTier) || 'standard'
      insertSelectedSingle(tier)
    })
  }

  for (const btn of mediaMultiBtns) {
    btn.addEventListener('click', () => {
      const group = (btn.dataset.mediaInsertGroup as 'grid-auto' | 'grid-2' | 'grid-3' | 'stage') || 'grid-auto'
      insertSelectedGroup(group)
    })
  }

  async function handleLibraryUploadFiles(files: FileList | File[]): Promise<void> {
    const summary = await options.onUploadToLibrary(files)
    if (summary.repoPaths.length > 0) {
      options.onMediaChanged?.()
      let auditNote = ''
      if (summary.duplicateMatches.length > 0) {
        const dupNames = summary.duplicateMatches.map(d => d.existingName).join('、')
        auditNote = summary.newCount > 0
          ? `上传完成：新增 ${summary.newCount} 张；另有 ${summary.duplicateMatches.length} 张重复图片已去重复用（${dupNames}）`
          : `上传去重校验：检测到与现有素材内容完全一致（${dupNames}），未重复写入磁盘，已为你自动选中`
      }
      if (!mediaModalEl.classList.contains('hidden')) {
        await loadAndShowMediaLibrary({
          preselectPaths: summary.repoPaths,
          auditNote,
        })
      }
    }
  }

  mediaUploadBtn.addEventListener('click', () => mediaUploadInput.click())
  mediaUploadInput.addEventListener('change', async () => {
    if (mediaUploadInput.files && mediaUploadInput.files.length > 0) {
      await handleLibraryUploadFiles(mediaUploadInput.files)
      mediaUploadInput.value = ''
    }
  })

  mediaPanelEl.addEventListener('dragover', (ev) => {
    if (ev.dataTransfer?.types.includes('Files')) {
      ev.preventDefault()
      mediaPanelEl.classList.add('ring-2', 'ring-primary/50')
    }
  })

  mediaPanelEl.addEventListener('dragleave', (ev) => {
    if (ev.relatedTarget instanceof Node && mediaPanelEl.contains(ev.relatedTarget)) {
      return
    }
    mediaPanelEl.classList.remove('ring-2', 'ring-primary/50')
  })

  mediaPanelEl.addEventListener('drop', (ev) => {
    mediaPanelEl.classList.remove('ring-2', 'ring-primary/50')
    const files = ev.dataTransfer?.files
    if (!files || files.length === 0) {
      return
    }
    const hasImg = Array.from(files).some(f => f.type.startsWith('image/') || /\.(?:png|jpe?g|webp|gif|svg|avif)$/i.test(f.name))
    if (hasImg) {
      ev.preventDefault()
      void handleLibraryUploadFiles(files)
    }
  })

  // Event listeners for Image Inspector
  options.previewBodyEl.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement
    if (target.closest('[data-stage-thumb]')) {
      return
    }
    const imgEl = target.closest<HTMLElement>('[data-admin-img-idx]')
    if (!imgEl) {
      return
    }
    const idx = Number.parseInt(imgEl.dataset.adminImgIdx || '-1', 10)
    if (idx < 0) {
      return
    }
    ev.preventDefault()
    ev.stopPropagation()
    openInspectorForImage(imgEl, idx)
  })

  inspectorCloseBtn.addEventListener('click', () => closeInspector())
  inspectorAltInput.addEventListener('input', () => applyInspectorChanges())
  inspectorHideCheck.addEventListener('change', () => applyInspectorChanges())

  for (const btn of inspectorTierBtns) {
    btn.addEventListener('click', () => {
      const tier = (btn.dataset.inspectorTier as ImageTier) || 'standard'
      applyInspectorChanges(tier)
    })
  }

  inspectorLocateBtn.addEventListener('click', () => {
    if (activeInspectIdx === null) {
      return
    }
    const tokens = findMarkdownImages(options.getBody())
    const token = tokens[activeInspectIdx]
    if (!token) {
      return
    }
    options.applyBodyChange(options.getBody(), { selectRange: [token.start, token.end] })
    closeInspector()
  })

  inspectorRemoveBtn.addEventListener('click', () => {
    if (activeInspectIdx === null) {
      return
    }
    const body = options.getBody()
    const tokens = findMarkdownImages(body)
    const token = tokens[activeInspectIdx]
    if (!token) {
      closeInspector()
      return
    }
    let delStart = token.start
    let delEnd = token.end
    if (body[delEnd] === '\r' && body[delEnd + 1] === '\n') {
      delEnd += 2
    }
    else if (body[delEnd] === '\n') {
      delEnd += 1
    }
    if (delStart > 0 && body[delStart - 1] === '\n' && delEnd < body.length && body[delEnd] === '\n') {
      delStart -= 1
    }
    const nextBody = `${body.slice(0, delStart)}${body.slice(delEnd)}`
    options.applyBodyChange(nextBody)
    closeInspector()
    options.showToast('已从正文移除该图片', 'info')
  })

  document.addEventListener('pointerdown', (ev) => {
    const target = ev.target as Node
    if (!inspectorEl.classList.contains('hidden')
      && !inspectorEl.contains(target)
      && !(target instanceof Element && target.closest('[data-admin-img-idx]'))) {
      closeInspector()
    }
  })

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!inspectorEl.classList.contains('hidden')) {
        closeInspector()
      }
      if (!mediaModalEl.classList.contains('hidden')) {
        closeMediaLibrary()
      }
    }
  })

  options.previewPaneEl.addEventListener('scroll', () => {
    if (!inspectorEl.classList.contains('hidden')) {
      closeInspector()
    }
  })

  return {
    openMediaLibrary: loadAndShowMediaLibrary,
    closeInspector,
    refreshIfOpen: async () => {
      if (!mediaModalEl.classList.contains('hidden')) {
        await loadAndShowMediaLibrary()
      }
    },
  }
}

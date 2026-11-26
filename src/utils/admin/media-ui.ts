import type { AdminMediaItem, StorageAdapter } from './storage'
import { computeRelativeImagePath } from './frontmatter'

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

export interface AdminMediaUIOptions {
  getAdapter: () => StorageAdapter | null
  getActivePath: () => string | null
  getBody: () => string
  applyBodyChange: (nextBody: string, opts?: { selectRange?: [number, number] }) => void
  insertAtCursor: (text: string) => void
  onUploadFiles: (files: FileList | File[]) => Promise<void>
  askConfirm: (title: string, desc: string, confirmText?: string) => Promise<boolean>
  showToast: (message: string, tone?: 'info' | 'success' | 'error') => void
  bodyTextarea: HTMLTextAreaElement
  previewPaneEl: HTMLElement
  previewBodyEl: HTMLElement
}

export interface AdminMediaUIHandle {
  openMediaLibrary: () => Promise<void>
  closeInspector: () => void
  refreshIfOpen: () => Promise<void>
}

export function initAdminMediaUI(options: AdminMediaUIOptions): AdminMediaUIHandle {
  // Media Library Modal DOM
  const mediaModalEl = qs<HTMLElement>('modal-media-library')
  const mediaCloseBtn = qs<HTMLButtonElement>('btn-media-close')
  const mediaUploadBtn = qs<HTMLButtonElement>('btn-media-upload')
  const mediaUploadInput = qs<HTMLInputElement>('input-media-upload')
  const mediaSearchInput = qs<HTMLInputElement>('media-search-input')
  const mediaFilterBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-media-filter]'))
  const mediaGridEl = qs<HTMLElement>('media-library-grid')
  const mediaEmptyEl = qs<HTMLElement>('media-library-empty')
  const mediaSelectionHintEl = qs<HTMLElement>('media-selection-hint')
  const mediaSingleActionsEl = qs<HTMLElement>('media-single-actions')
  const mediaMultiActionsEl = qs<HTMLElement>('media-multi-actions')
  const mediaGroupTitleInput = qs<HTMLInputElement>('media-group-title')
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

  let mediaItems: AdminMediaItem[] = []
  let mediaFilter: 'all' | 'used' | 'unused' = 'all'
  let mediaSearch = ''
  let selectedPaths: string[] = []
  let activeInspectIdx: number | null = null

  function isMediaUsed(item: AdminMediaItem): boolean {
    const body = options.getBody()
    return body.includes(item.filename) || body.includes(item.repoPath)
  }

  function updateMediaActionBar(): void {
    const count = selectedPaths.length
    mediaClearSelectionBtn.classList.toggle('hidden', count === 0)

    if (count === 0) {
      mediaSelectionHintEl.textContent = '点选图片插入正文；多选 2 张及以上可一键插入多宫格或舞台画廊'
      mediaSelectionHintEl.classList.remove('hidden')
      mediaSingleActionsEl.classList.add('hidden')
      mediaSingleActionsEl.classList.remove('flex')
      mediaMultiActionsEl.classList.add('hidden')
      mediaMultiActionsEl.classList.remove('flex')
      return
    }

    if (count === 1) {
      mediaSelectionHintEl.textContent = '已选 1 张图片：选择排版档位插入'
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
    const query = mediaSearch.trim().toLowerCase()
    const filtered = mediaItems.filter((item) => {
      const used = isMediaUsed(item)
      if (mediaFilter === 'used' && !used) {
        return false
      }
      if (mediaFilter === 'unused' && used) {
        return false
      }
      if (query && !item.filename.toLowerCase().includes(query) && !item.repoPath.toLowerCase().includes(query)) {
        return false
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
      const used = isMediaUsed(item)
      const badgeClass = item.pending
        ? 'bg-amber-500/15 c-amber-700 dark:c-amber-400'
        : used
          ? 'bg-emerald-500/15 c-emerald-700 dark:c-emerald-400'
          : 'bg-secondary/10 c-secondary/75'
      const badgeLabel = item.pending ? '待提交' : used ? '已用' : '未用'
      const cardRing = isSelected
        ? 'border-primary/70 ring-2 ring-highlight'
        : 'border-secondary/15 hover:border-primary/35'

      return `<div data-media-card="${escapeHtml(item.repoPath)}" class="group relative flex flex-col overflow-hidden uno-round-border bg-background transition-all cursor-pointer ${cardRing}">
        <div class="relative aspect-16/10 w-full overflow-hidden bg-secondary/5">
          <img
            data-media-repo="${escapeHtml(item.repoPath)}"
            src="${escapeHtml(item.previewUrl)}"
            alt="${escapeHtml(item.filename)}"
            loading="lazy"
            class="h-full w-full object-cover"
          />
          <span class="absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${isSelected ? 'bg-primary c-background' : 'bg-black/55 text-white'}">
            ${isSelected ? `#${selIdx + 1}` : '选择'}
          </span>
          ${!used
            ? `<button type="button" data-delete-media="${escapeHtml(item.repoPath)}" class="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white op-0 transition-opacity group-hover:op-100 hover:bg-red-600" title="${item.pending ? '撤销暂存的待提交图片' : '永久删除未引用的图片文件'}">${item.pending ? '撤销' : '删除'}</button>`
            : ''}
        </div>
        <div class="flex items-center justify-between gap-2 px-2.5 py-1.5">
          <span class="min-w-0 truncate text-[11px] c-primary" title="${escapeHtml(item.repoPath)}">${escapeHtml(item.filename)}</span>
          <span class="shrink-0 rounded px-1.5 py-0.5 text-[10px] ${badgeClass}">${badgeLabel}</span>
        </div>
        <div class="px-2.5 pb-2 text-[10px] c-secondary/65 font-mono">${formatFileSize(item.size)}</div>
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

  async function loadAndShowMediaLibrary(): Promise<void> {
    const adapter = options.getAdapter()
    if (!adapter) {
      return
    }
    mediaModalEl.classList.remove('hidden')
    mediaModalEl.classList.add('flex')
    mediaGridEl.innerHTML = '<div class="col-span-full py-10 text-center text-xs c-secondary/70">正在加载素材库...</div>'
    mediaEmptyEl.classList.add('hidden')

    try {
      mediaItems = await adapter.listMedia()
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
    if (!activePath || selectedPaths.length !== 1) {
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
    if (!activePath || selectedPaths.length < 2) {
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

  for (const btn of mediaFilterBtns) {
    btn.addEventListener('click', () => {
      mediaFilter = (btn.dataset.mediaFilter as 'all' | 'used' | 'unused') || 'all'
      for (const b of mediaFilterBtns) {
        const active = b === btn
        b.classList.toggle('bg-highlight', active)
        b.classList.toggle('c-primary', active)
        b.classList.toggle('font-medium', active)
      }
      renderMediaGrid()
    })
  }

  mediaGridEl.addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement
    const delBtn = target.closest<HTMLElement>('[data-delete-media]')
    if (delBtn) {
      ev.stopPropagation()
      const repoPath = delBtn.dataset.deleteMedia
      if (!repoPath) {
        return
      }
      const ok = await options.askConfirm('删除图片资源', `确定永久删除「${repoPath}」吗？若文章仍在引用该图片将导致裂图。`, '确认删除')
      if (!ok) {
        return
      }
      const adapter = options.getAdapter()
      if (!adapter) {
        return
      }
      try {
        await adapter.deleteMedia(repoPath)
        selectedPaths = selectedPaths.filter(p => p !== repoPath)
        mediaItems = mediaItems.filter(m => m.repoPath !== repoPath)
        renderMediaGrid()
        options.showToast('图片文件已删除', 'success')
      }
      catch (err) {
        options.showToast(err instanceof Error ? err.message : '删除图片失败', 'error')
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

  mediaUploadBtn.addEventListener('click', () => mediaUploadInput.click())
  mediaUploadInput.addEventListener('change', async () => {
    if (mediaUploadInput.files && mediaUploadInput.files.length > 0) {
      await options.onUploadFiles(mediaUploadInput.files)
      mediaUploadInput.value = ''
      if (!mediaModalEl.classList.contains('hidden')) {
        await loadAndShowMediaLibrary()
      }
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

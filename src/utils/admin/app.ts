import type { ContentKind, PostLang, PostMeta } from './frontmatter'
import type { AdminMediaUIHandle } from './media-ui'
import type { AdminFileData, AdminFileSummary, StorageAdapter } from './storage'
import { base } from '@/config'
import {
  computePostRoute,
  createDefaultPostMeta,
  getTodayDateString,
  parseMarkdownFile,
  serializeMarkdownFile,
  suggestSlug,
  validatePostMeta,
} from './frontmatter'
import { initAdminMediaUI } from './media-ui'
import { hydratePreviewImages, renderMarkdownPreview, wirePreviewStageGalleries } from './preview'
import {
  clearGitHubConfig,
  detectLocalMode,
  GitHubStorageAdapter,
  loadGitHubConfig,
  LocalStorageAdapter,
  saveGitHubConfig,
} from './storage'

type FilterKind = 'all' | 'zh' | 'en' | 'universal' | 'draft'
type ViewMode = 'edit' | 'split' | 'preview'

interface AdminState {
  adapter: StorageAdapter | null
  localAvailable: boolean
  formatSupported: boolean
  files: AdminFileSummary[]
  activePath: string | null
  activeKind: ContentKind
  meta: PostMeta
  body: string
  dirty: boolean
  saving: boolean
  filter: FilterKind
  searchQuery: string
  viewMode: ViewMode
  sidebarOpen: boolean
  metaOpen: boolean
}

function qs<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) {
    throw new Error(`Missing admin element #${id}`)
  }
  return el as T
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function countContentWords(text: string): { chars: number, minutes: number } {
  const cleaned = text.replace(/\s+/g, '')
  const chars = cleaned.length
  const minutes = Math.max(1, Math.ceil(chars / 350))
  return { chars, minutes }
}

export function initAdminApp(): void {
  const state: AdminState = {
    adapter: null,
    localAvailable: false,
    formatSupported: false,
    files: [],
    activePath: null,
    activeKind: 'post',
    meta: createDefaultPostMeta('zh'),
    body: '',
    dirty: false,
    saving: false,
    filter: 'all',
    searchQuery: '',
    viewMode: window.innerWidth < 1024 ? 'edit' : 'split',
    sidebarOpen: window.innerWidth >= 768,
    metaOpen: true,
  }

  // DOM references
  const sidebarEl = qs<HTMLElement>('admin-sidebar')
  const toggleSidebarBtn = qs<HTMLButtonElement>('btn-toggle-sidebar')
  const modeBadgeBtn = qs<HTMLButtonElement>('btn-mode-badge')
  const ghActionsLink = qs<HTMLAnchorElement>('link-gh-actions')
  const modeLabelEl = qs<HTMLElement>('mode-label')
  const modeDotEl = qs<HTMLElement>('mode-dot')
  const activeFilePathEl = qs<HTMLElement>('active-file-path')
  const dirtyBadgeEl = qs<HTMLElement>('dirty-badge')
  const saveBtn = qs<HTMLButtonElement>('btn-save')
  const themeToggleBtn = qs<HTMLButtonElement>('btn-theme-toggle')

  const newPostOpenBtn = qs<HTMLButtonElement>('btn-new-post')
  const searchInput = qs<HTMLInputElement>('search-input')
  const filterBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-filter]'))
  const postListEl = qs<HTMLElement>('post-list')
  const aboutListEl = qs<HTMLElement>('about-list')

  const workspaceEmptyEl = qs<HTMLElement>('workspace-empty')
  const workspaceEditorEl = qs<HTMLElement>('workspace-editor')
  const metaPanelToggleBtn = qs<HTMLButtonElement>('btn-toggle-meta')
  const metaFieldsEl = qs<HTMLElement>('meta-fields')
  const postOnlyMetaEls = Array.from(document.querySelectorAll<HTMLElement>('[data-post-only]'))

  const inputTitle = qs<HTMLInputElement>('meta-title')
  const inputPublished = qs<HTMLInputElement>('meta-published')
  const inputUpdated = qs<HTMLInputElement>('meta-updated')
  const inputLang = qs<HTMLSelectElement>('meta-lang')
  const inputAbbrlink = qs<HTMLInputElement>('meta-abbrlink')
  const genSlugBtn = qs<HTMLButtonElement>('btn-gen-slug')
  const inputTags = qs<HTMLInputElement>('meta-tags')
  const inputPin = qs<HTMLInputElement>('meta-pin')
  const inputDraft = qs<HTMLInputElement>('meta-draft')
  const inputToc = qs<HTMLInputElement>('meta-toc')
  const inputDescription = qs<HTMLInputElement>('meta-description')

  const pairLangBtn = qs<HTMLButtonElement>('btn-pair-lang')
  const viewPageLink = qs<HTMLAnchorElement>('link-view-page')
  const deletePostBtn = qs<HTMLButtonElement>('btn-delete-post')

  const viewModeBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-view-mode]'))
  const formatBtn = qs<HTMLButtonElement>('btn-format-body')
  const uploadImgBtn = qs<HTMLButtonElement>('btn-upload-image')
  const mediaLibraryBtn = qs<HTMLButtonElement>('btn-media-library')
  const insertGridBtn = qs<HTMLButtonElement>('btn-insert-grid')
  const insertGalleryBtn = qs<HTMLButtonElement>('btn-insert-gallery')
  const uploadImgInput = qs<HTMLInputElement>('input-upload-image')
  const wordCountEl = qs<HTMLElement>('word-count')
  const toolbarActionBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-md-action]'))

  const panesContainerEl = qs<HTMLElement>('editor-panes')
  const editorPaneEl = qs<HTMLElement>('pane-editor')
  const previewPaneEl = qs<HTMLElement>('pane-preview')
  const bodyTextarea = qs<HTMLTextAreaElement>('body-editor')
  const previewTitleEl = qs<HTMLElement>('preview-title')
  const previewMetaEl = qs<HTMLElement>('preview-meta')
  const previewBodyEl = qs<HTMLElement>('preview-body')

  // New Post Modal
  const newModalEl = qs<HTMLElement>('modal-new-post')
  const newTitleInput = qs<HTMLInputElement>('new-post-title')
  const newLangSelect = qs<HTMLSelectElement>('new-post-lang')
  const newPathInput = qs<HTMLInputElement>('new-post-path')
  const newCancelBtn = qs<HTMLButtonElement>('btn-new-cancel')
  const newCreateBtn = qs<HTMLButtonElement>('btn-new-confirm')

  // GitHub Settings Modal
  const ghModalEl = qs<HTMLElement>('modal-github')
  const ghRepoInput = qs<HTMLInputElement>('gh-repo')
  const ghBranchInput = qs<HTMLInputElement>('gh-branch')
  const ghTokenInput = qs<HTMLInputElement>('gh-token')
  const ghTestBtn = qs<HTMLButtonElement>('btn-gh-test')
  const ghSaveBtn = qs<HTMLButtonElement>('btn-gh-save')
  const ghSwitchLocalBtn = qs<HTMLButtonElement>('btn-gh-local')
  const ghClearBtn = qs<HTMLButtonElement>('btn-gh-clear')
  const ghCloseBtn = qs<HTMLButtonElement>('btn-gh-close')
  const ghStatusEl = qs<HTMLElement>('gh-test-status')

  // Confirm Modal
  const confirmModalEl = qs<HTMLElement>('modal-confirm')
  const confirmTitleEl = qs<HTMLElement>('confirm-title')
  const confirmDescEl = qs<HTMLElement>('confirm-desc')
  const confirmCancelBtn = qs<HTMLButtonElement>('btn-confirm-cancel')
  const confirmOkBtn = qs<HTMLButtonElement>('btn-confirm-ok')

  // Rename Modal
  const renameModalEl = qs<HTMLElement>('modal-rename-post')
  const renamePathInput = qs<HTMLInputElement>('rename-post-path')
  const renameCancelBtn = qs<HTMLButtonElement>('btn-rename-cancel')
  const renameConfirmBtn = qs<HTMLButtonElement>('btn-rename-confirm')

  // Context Menu
  const contextMenuEl = qs<HTMLElement>('admin-context-menu')

  // Toast
  const toastEl = qs<HTMLElement>('admin-toast')
  let toastTimer: number | undefined
  let previewTimer: number | undefined
  let newPathManual = false
  let renameSourcePath: string | null = null
  let mediaUI: AdminMediaUIHandle | null = null
  const draftFiles = new Map<string, AdminFileData>()

  function showToast(message: string, tone: 'info' | 'success' | 'error' = 'info'): void {
    toastEl.textContent = message
    toastEl.classList.remove('hidden', 'border-emerald-600/40', 'text-emerald-700', 'border-red-600/40', 'text-red-700', 'dark:text-emerald-400', 'dark:text-red-400')
    if (tone === 'success') {
      toastEl.classList.add('border-emerald-600/40', 'text-emerald-700', 'dark:text-emerald-400')
    }
    else if (tone === 'error') {
      toastEl.classList.add('border-red-600/40', 'text-red-700', 'dark:text-red-400')
    }
    if (toastTimer) {
      window.clearTimeout(toastTimer)
    }
    toastTimer = window.setTimeout(() => {
      toastEl.classList.add('hidden')
    }, 3200)
  }

  function askConfirm(title: string, desc: string, confirmText = '确定'): Promise<boolean> {
    return new Promise((resolve) => {
      confirmTitleEl.textContent = title
      confirmDescEl.textContent = desc
      confirmOkBtn.textContent = confirmText
      confirmModalEl.classList.remove('hidden')
      confirmModalEl.classList.add('flex')

      let onCancel: () => void
      let onOk: () => void

      const cleanup = (result: boolean) => {
        confirmModalEl.classList.add('hidden')
        confirmModalEl.classList.remove('flex')
        confirmCancelBtn.removeEventListener('click', onCancel)
        confirmOkBtn.removeEventListener('click', onOk)
        resolve(result)
      }

      onCancel = () => cleanup(false)
      onOk = () => cleanup(true)

      confirmCancelBtn.addEventListener('click', onCancel)
      confirmOkBtn.addEventListener('click', onOk)
    })
  }

  function setDirty(flag: boolean): void {
    state.dirty = flag
    dirtyBadgeEl.classList.toggle('hidden', !flag)
  }

  function updateModeUI(): void {
    const isGitHub = state.adapter?.mode === 'github'
    const pendingCount = isGitHub ? (state.adapter?.getPendingUploadCount?.() ?? 0) : 0
    const actionsUrl = isGitHub ? (state.adapter?.getActionsUrl?.() || '') : ''

    modeLabelEl.textContent = isGitHub ? 'GitHub 模式' : '本地模式'
    modeDotEl.classList.toggle('bg-emerald-500', !isGitHub)
    modeDotEl.classList.toggle('bg-amber-500', isGitHub)

    if (actionsUrl) {
      ghActionsLink.href = actionsUrl
      ghActionsLink.classList.remove('hidden')
    }
    else {
      ghActionsLink.classList.add('hidden')
    }

    saveBtn.textContent = state.saving
      ? '保存中...'
      : isGitHub
        ? (pendingCount > 0 ? `提交发布 (含 ${pendingCount} 图)` : '提交发布')
        : '保存'
    formatBtn.classList.toggle('hidden', !(state.adapter?.formatBody))
    ghSwitchLocalBtn.classList.toggle('hidden', !state.localAvailable)
  }

  function updateSidebarUI(): void {
    sidebarEl.classList.toggle('hidden', !state.sidebarOpen)
    sidebarEl.classList.toggle('flex', state.sidebarOpen)
  }

  function updateViewModeUI(): void {
    for (const btn of viewModeBtns) {
      const active = btn.dataset.viewMode === state.viewMode
      btn.classList.toggle('bg-highlight', active)
      btn.classList.toggle('c-primary', active)
      btn.classList.toggle('font-medium', active)
    }

    panesContainerEl.classList.remove('grid-cols-1', 'lg:grid-cols-2')
    if (state.viewMode === 'split') {
      panesContainerEl.classList.add('grid-cols-1', 'lg:grid-cols-2')
      editorPaneEl.classList.remove('hidden')
      editorPaneEl.classList.add('flex')
      previewPaneEl.classList.remove('hidden')
    }
    else if (state.viewMode === 'edit') {
      panesContainerEl.classList.add('grid-cols-1')
      editorPaneEl.classList.remove('hidden')
      editorPaneEl.classList.add('flex')
      previewPaneEl.classList.add('hidden')
    }
    else {
      panesContainerEl.classList.add('grid-cols-1')
      editorPaneEl.classList.add('hidden')
      editorPaneEl.classList.remove('flex')
      previewPaneEl.classList.remove('hidden')
    }
  }

  function updateWordCount(): void {
    const { chars, minutes } = countContentWords(state.body)
    wordCountEl.textContent = `${chars} 字 · 约 ${minutes} 分钟`
  }

  function schedulePreviewRender(): void {
    if (previewTimer) {
      window.clearTimeout(previewTimer)
    }
    previewTimer = window.setTimeout(() => {
      void renderPreviewNow()
    }, 120)
  }

  async function renderPreviewNow(): Promise<void> {
    if (!state.activePath) {
      return
    }
    const displayTitle = state.activeKind === 'about'
      ? (state.meta.lang === 'en' ? 'About' : '关于')
      : (state.meta.title.trim() || '未命名文章')
    previewTitleEl.textContent = displayTitle

    if (state.activeKind === 'post') {
      const { minutes } = countContentWords(state.body)
      const langTag = state.meta.lang === 'zh' ? '中文' : state.meta.lang === 'en' ? 'English' : '双语通用'
      const draftTag = state.meta.draft ? ' · 草稿' : ''
      previewMetaEl.textContent = `${state.meta.published || getTodayDateString()} · ${minutes} min · ${langTag}${draftTag}`
      previewMetaEl.classList.remove('hidden')
    }
    else {
      previewMetaEl.classList.add('hidden')
    }

    previewBodyEl.innerHTML = renderMarkdownPreview(state.body)
    wirePreviewStageGalleries(previewBodyEl)
    if (state.adapter) {
      await hydratePreviewImages(previewBodyEl, state.activePath, state.adapter)
    }
  }

  function syncMetaToInputs(): void {
    const isPost = state.activeKind === 'post'
    for (const el of postOnlyMetaEls) {
      el.classList.toggle('hidden', !isPost)
    }

    inputTitle.value = state.meta.title
    inputPublished.value = state.meta.published
    inputUpdated.value = state.meta.updated
    inputLang.value = state.meta.lang
    inputAbbrlink.value = state.meta.abbrlink
    inputTags.value = state.meta.tags.join(', ')
    inputPin.value = String(state.meta.pin)
    inputDraft.checked = state.meta.draft
    inputToc.checked = state.meta.toc
    inputDescription.value = state.meta.description

    deletePostBtn.classList.toggle('hidden', !isPost)
    updatePostActionButtons()
  }

  function readInputsToMeta(): void {
    state.meta.title = inputTitle.value
    state.meta.published = inputPublished.value
    state.meta.updated = inputUpdated.value
    const rawLang = inputLang.value
    state.meta.lang = rawLang === 'zh' || rawLang === 'en' ? rawLang : ''
    state.meta.abbrlink = inputAbbrlink.value.trim()
    state.meta.tags = inputTags.value
      .split(/[,，]/)
      .map(t => t.trim())
      .filter(Boolean)
    const parsedPin = Number.parseInt(inputPin.value, 10)
    state.meta.pin = Number.isFinite(parsedPin) ? Math.min(99, Math.max(0, parsedPin)) : 0
    state.meta.draft = inputDraft.checked
    state.meta.toc = inputToc.checked
    state.meta.description = inputDescription.value
  }

  function findSiblingTranslation(filePath: string, meta: PostMeta): AdminFileSummary | undefined {
    const targetLang: PostLang | null = meta.lang === 'zh' ? 'en' : meta.lang === 'en' ? 'zh' : null
    if (!targetLang || !meta.abbrlink.trim()) {
      return undefined
    }
    return state.files.find(
      f => f.kind === 'post'
        && f.path !== filePath
        && f.meta.lang === targetLang
        && f.meta.abbrlink.trim() === meta.abbrlink.trim(),
    )
  }

  function updatePostActionButtons(): void {
    if (!state.activePath) {
      return
    }
    if (state.activeKind === 'about') {
      pairLangBtn.classList.remove('hidden')
      const targetAbout = state.meta.lang === 'en'
        ? 'src/content/about/about-zh.md'
        : 'src/content/about/about-en.md'
      pairLangBtn.textContent = state.meta.lang === 'en' ? '切换到中文关于' : '切换到英文关于'
      pairLangBtn.dataset.targetPath = targetAbout
      viewPageLink.href = state.meta.lang === 'en' ? `${base}/en/about/` : `${base}/about/`
      return
    }

    viewPageLink.href = computePostRoute(state.activePath, state.meta)
    if (state.meta.lang === 'zh' || state.meta.lang === 'en') {
      pairLangBtn.classList.remove('hidden')
      const sibling = findSiblingTranslation(state.activePath, state.meta)
      if (sibling) {
        pairLangBtn.textContent = state.meta.lang === 'zh' ? '切换英文版' : '切换中文版'
        pairLangBtn.dataset.targetPath = sibling.path
      }
      else {
        pairLangBtn.textContent = state.meta.lang === 'zh' ? '创建英文版' : '创建中文版'
        pairLangBtn.dataset.targetPath = ''
      }
    }
    else {
      pairLangBtn.classList.add('hidden')
    }
  }

  function renderFileLists(): void {
    const query = state.searchQuery.trim().toLowerCase()
    const posts = state.files
      .filter(f => f.kind === 'post')
      .filter((f) => {
        if (state.filter === 'zh') {
          return f.meta.lang === 'zh'
        }
        if (state.filter === 'en') {
          return f.meta.lang === 'en'
        }
        if (state.filter === 'universal') {
          return f.meta.lang === ''
        }
        if (state.filter === 'draft') {
          return f.meta.draft
        }
        return true
      })
      .filter((f) => {
        if (!query) {
          return true
        }
        const hay = `${f.meta.title} ${f.path} ${f.meta.tags.join(' ')} ${f.meta.abbrlink}`.toLowerCase()
        return hay.includes(query)
      })
      .sort((a, b) => {
        if (a.meta.pin !== b.meta.pin) {
          return b.meta.pin - a.meta.pin
        }
        return (b.meta.published || '').localeCompare(a.meta.published || '')
      })

    if (posts.length === 0) {
      postListEl.innerHTML = '<div class="px-2 py-6 text-center text-xs c-secondary/60">没有匹配的文章</div>'
    }
    else {
      postListEl.innerHTML = posts.map((item) => {
        const isActive = item.path === state.activePath
        const langBadge = item.meta.lang === 'zh' ? '中' : item.meta.lang === 'en' ? 'EN' : '通用'
        const pinText = item.meta.pin > 0 ? '<span class="text-[11px] c-primary/70">置顶</span>' : ''
        const draftText = item.meta.draft ? '<span class="text-[11px] c-amber-600 dark:c-amber-400">草稿</span>' : ''
        const activeClass = isActive
          ? 'bg-highlight c-primary font-medium'
          : 'hover:bg-secondary/5 c-secondary'

        return `<button type="button" data-open-path="${escapeHtml(item.path)}" class="w-full flex flex-col items-stretch text-left px-2.5 py-2 rounded transition-colors ${activeClass}">
          <div class="w-full truncate text-left text-sm leading-snug">${escapeHtml(item.meta.title || item.path)}</div>
          <div class="mt-0.5 flex items-center gap-1.5 text-[11px] opacity-75">
            <span>${escapeHtml(item.meta.published || '')}</span>
            <span>·</span>
            <span>${langBadge}</span>
            ${pinText}
            ${draftText}
          </div>
        </button>`
      }).join('')
    }

    const abouts = state.files
      .filter(f => f.kind === 'about')
      .sort((a, b) => a.path.localeCompare(b.path))

    aboutListEl.innerHTML = abouts.map((item) => {
      const isActive = item.path === state.activePath
      const label = item.path.includes('-en') ? '关于页面 · English' : '关于页面 · 中文'
      const activeClass = isActive
        ? 'bg-highlight c-primary font-medium'
        : 'hover:bg-secondary/5 c-secondary'
      return `<button type="button" data-open-path="${escapeHtml(item.path)}" class="w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors ${activeClass}">${label}</button>`
    }).join('')
  }

  async function openFile(filePath: string, skipConfirm = false): Promise<void> {
    if (!state.adapter) {
      return
    }
    if (!skipConfirm && state.dirty && state.activePath && state.activePath !== filePath) {
      const ok = await askConfirm('切换文章', '当前文章有未保存的修改，确定放弃修改并切换吗？', '放弃并切换')
      if (!ok) {
        return
      }
    }

    try {
      const memDraft = draftFiles.get(filePath)
      const data: AdminFileData = memDraft ?? await state.adapter.readFile(filePath)
      state.activePath = data.path
      state.activeKind = data.kind
      state.meta = { ...data.meta, tags: [...data.meta.tags], extra: { ...data.meta.extra } }
      state.body = data.body
      activeFilePathEl.textContent = data.path
      workspaceEmptyEl.classList.add('hidden')
      workspaceEmptyEl.classList.remove('flex')
      workspaceEditorEl.classList.remove('hidden')
      workspaceEditorEl.classList.add('flex')

      bodyTextarea.value = data.body
      mediaUI?.closeInspector()
      syncMetaToInputs()
      updateWordCount()
      setDirty(Boolean(memDraft))
      renderFileLists()
      await renderPreviewNow()
    }
    catch (err) {
      showToast(err instanceof Error ? err.message : '打开文章失败', 'error')
    }
  }

  async function refreshFileList(selectPath?: string): Promise<void> {
    if (!state.adapter) {
      return
    }
    state.files = await state.adapter.listFiles()
    renderFileLists()

    if (selectPath) {
      await openFile(selectPath, true)
      return
    }

    if (!state.activePath && state.files.length > 0) {
      const firstPost = state.files
        .filter(f => f.kind === 'post')
        .sort((a, b) => (b.meta.published || '').localeCompare(a.meta.published || ''))[0]
      if (firstPost) {
        await openFile(firstPost.path, true)
      }
    }
  }

  async function saveCurrentFile(): Promise<boolean> {
    if (!state.adapter || !state.activePath || state.saving) {
      return false
    }

    state.body = bodyTextarea.value
    readInputsToMeta()
    const pendingCount = state.adapter.getPendingUploadCount?.() ?? 0
    const isDraftNew = draftFiles.has(state.activePath)
    if (!state.dirty && !isDraftNew && pendingCount === 0) {
      showToast('当前内容无改动，无需重复提交', 'info')
      return true
    }

    const errors = validatePostMeta(state.meta, state.activeKind)
    if (errors.length > 0) {
      showToast(errors[0], 'error')
      return false
    }

    if (state.activeKind === 'post') {
      const targetSlug = state.meta.abbrlink.trim()
        || state.activePath.replace(/^src\/content\/posts\//, '').replace(/\.(?:md|mdx)$/i, '').toLowerCase()
      const duplicate = state.files.find((f) => {
        if (f.kind !== 'post' || f.path === state.activePath) {
          return false
        }
        const fSlug = f.meta.abbrlink.trim()
          || f.path.replace(/^src\/content\/posts\//, '').replace(/\.(?:md|mdx)$/i, '').toLowerCase()
        if (fSlug !== targetSlug) {
          return false
        }
        return f.meta.lang === state.meta.lang || f.meta.lang === '' || state.meta.lang === ''
      })
      if (duplicate) {
        showToast(`链接标识 "${targetSlug}" 与 ${duplicate.path} 冲突，请更换 abbrlink`, 'error')
        return false
      }
    }

    state.saving = true
    updateModeUI()

    try {
      const serialized = serializeMarkdownFile(state.meta, state.body, state.activeKind)
      const commitMsg = state.activeKind === 'about'
        ? `docs: update ${state.activePath}`
        : `post: update ${state.meta.title.trim() || state.activePath}`
      await state.adapter.saveFile(state.activePath, serialized, { commitMessage: commitMsg })

      const idx = state.files.findIndex(f => f.path === state.activePath)
      const summary: AdminFileSummary = {
        path: state.activePath,
        kind: state.activeKind,
        meta: { ...state.meta, tags: [...state.meta.tags], extra: { ...state.meta.extra } },
      }
      if (idx >= 0) {
        state.files[idx] = summary
      }
      else {
        state.files.push(summary)
      }

      setDirty(false)
      draftFiles.delete(state.activePath)
      renderFileLists()
      updatePostActionButtons()
      updateModeUI()
      showToast(
        state.adapter.mode === 'github'
          ? '已一次提交到 GitHub（可点击右上角「部署进度 ↗」查看构建）'
          : '已保存到本地文件',
        'success',
      )
      return true
    }
    catch (err) {
      showToast(err instanceof Error ? err.message : '保存失败', 'error')
      return false
    }
    finally {
      state.saving = false
      updateModeUI()
    }
  }

  async function deletePostByPath(targetPath: string, titleHint?: string): Promise<void> {
    if (!state.adapter || !targetPath.startsWith('src/content/posts/')) {
      return
    }
    const title = titleHint || targetPath
    const ok = await askConfirm('删除文章', `确定永久删除「${title}」吗？此操作无法撤销。`, '确认删除')
    if (!ok) {
      return
    }

    try {
      if (draftFiles.has(targetPath)) {
        draftFiles.delete(targetPath)
      }
      else {
        await state.adapter.deleteFile(targetPath, { commitMessage: `post: delete ${title}` })
      }
      state.files = state.files.filter(f => f.path !== targetPath)
      if (state.activePath === targetPath) {
        state.activePath = null
        setDirty(false)
      }
      renderFileLists()

      if (!state.activePath) {
        const nextPost = state.files.find(f => f.kind === 'post')
        if (nextPost) {
          await openFile(nextPost.path, true)
        }
        else {
          activeFilePathEl.textContent = '未选择文章'
          workspaceEditorEl.classList.add('hidden')
          workspaceEditorEl.classList.remove('flex')
          workspaceEmptyEl.classList.remove('hidden')
          workspaceEmptyEl.classList.add('flex')
        }
      }
      showToast('文章已删除', 'success')
    }
    catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  async function deleteCurrentPost(): Promise<void> {
    if (!state.activePath || state.activeKind !== 'post') {
      return
    }
    await deletePostByPath(state.activePath, state.meta.title || state.activePath)
  }

  async function formatEditorBody(): Promise<void> {
    if (!state.adapter?.formatBody) {
      return
    }
    try {
      const formatted = await state.adapter.formatBody(state.body)
      if (formatted !== state.body) {
        state.body = formatted
        bodyTextarea.value = formatted
        setDirty(true)
        updateWordCount()
        await renderPreviewNow()
        showToast('已优化中英文混排空格与标点', 'success')
      }
      else {
        showToast('排版已整洁，无需调整', 'info')
      }
    }
    catch (err) {
      showToast(err instanceof Error ? err.message : '自动排版失败', 'error')
    }
  }

  async function togglePostFlag(targetPath: string, flag: 'pin' | 'draft'): Promise<void> {
    if (!state.adapter) {
      return
    }
    try {
      if (state.activePath === targetPath) {
        readInputsToMeta()
        if (flag === 'pin') {
          state.meta.pin = state.meta.pin > 0 ? 0 : 99
        }
        else {
          state.meta.draft = !state.meta.draft
        }
        syncMetaToInputs()
        await saveCurrentFile()
        return
      }

      const fileData = await state.adapter.readFile(targetPath)
      if (flag === 'pin') {
        fileData.meta.pin = fileData.meta.pin > 0 ? 0 : 99
      }
      else {
        fileData.meta.draft = !fileData.meta.draft
      }
      const serialized = serializeMarkdownFile(fileData.meta, fileData.body, 'post')
      await state.adapter.saveFile(targetPath, serialized, {
        commitMessage: `post: toggle ${flag} on ${fileData.meta.title || targetPath}`,
      })
      const idx = state.files.findIndex(f => f.path === targetPath)
      if (idx >= 0) {
        state.files[idx] = { path: targetPath, kind: 'post', meta: fileData.meta }
      }
      renderFileLists()
      showToast(
        flag === 'pin'
          ? (fileData.meta.pin > 0 ? '已置顶文章' : '已取消置顶')
          : (fileData.meta.draft ? '已设为草稿' : '已取消草稿状态'),
        'success',
      )
    }
    catch (err) {
      showToast(err instanceof Error ? err.message : '更新状态失败', 'error')
    }
  }

  async function duplicatePost(targetPath: string): Promise<void> {
    if (!state.adapter) {
      return
    }
    try {
      const source = state.activePath === targetPath
        ? (() => {
            readInputsToMeta()
            return { meta: { ...state.meta, tags: [...state.meta.tags], extra: { ...state.meta.extra } }, body: state.body }
          })()
        : await state.adapter.readFile(targetPath)

      const extMatch = targetPath.match(/\.(md|mdx)$/i)
      const ext = extMatch ? `.${extMatch[1]}` : '.md'
      const stem = targetPath.replace(/\.(?:md|mdx)$/i, '')
      let copyPath = `${stem}-copy${ext}`
      let counter = 2
      while (state.files.some(f => f.path === copyPath)) {
        copyPath = `${stem}-copy-${counter}${ext}`
        counter += 1
      }

      const copyTitle = `${source.meta.title || 'Untitled'} (副本)`
      const baseSlug = source.meta.abbrlink.trim() || suggestSlug(source.meta.title)
      const copyMeta: PostMeta = {
        ...source.meta,
        title: copyTitle,
        published: getTodayDateString(),
        updated: '',
        pin: 0,
        draft: true,
        abbrlink: `${baseSlug}-copy-${Date.now().toString(36).slice(-4)}`,
      }

      const serialized = serializeMarkdownFile(copyMeta, source.body, 'post')
      await state.adapter.saveFile(copyPath, serialized, {
        commitMessage: `post: duplicate ${source.meta.title || targetPath}`,
      })
      await refreshFileList(copyPath)
      showToast('已复制为新草稿', 'success')
    }
    catch (err) {
      showToast(err instanceof Error ? err.message : '复制失败', 'error')
    }
  }

  function openRenameModal(targetPath: string): void {
    renameSourcePath = targetPath
    renamePathInput.value = targetPath
    renameModalEl.classList.remove('hidden')
    renameModalEl.classList.add('flex')
    renamePathInput.focus()
    renamePathInput.select()
  }

  async function confirmRenamePost(): Promise<void> {
    if (!state.adapter || !renameSourcePath) {
      return
    }
    const oldPath = renameSourcePath
    let newPath = renamePathInput.value.trim().replace(/\\/g, '/').replace(/^\/+/, '')
    if (!newPath.startsWith('src/content/posts/')) {
      newPath = `src/content/posts/${newPath}`
    }
    if (!/\.(?:md|mdx)$/i.test(newPath)) {
      newPath = `${newPath}.md`
    }
    if (newPath === oldPath) {
      renameModalEl.classList.add('hidden')
      renameModalEl.classList.remove('flex')
      return
    }
    if (state.files.some(f => f.path === newPath)) {
      showToast('目标路径已存在文件，请换一个名称', 'error')
      return
    }

    try {
      const content = state.activePath === oldPath
        ? (() => {
            readInputsToMeta()
            return serializeMarkdownFile(state.meta, state.body, 'post')
          })()
        : (await state.adapter.readFile(oldPath)).content

      await state.adapter.saveFile(newPath, content, {
        oldPath,
        commitMessage: `post: move ${oldPath} -> ${newPath}`,
      })
      renameModalEl.classList.add('hidden')
      renameModalEl.classList.remove('flex')
      renameSourcePath = null

      if (state.activePath === oldPath) {
        state.activePath = newPath
        activeFilePathEl.textContent = newPath
        setDirty(false)
      }
      await refreshFileList(state.activePath || newPath)
      showToast('文件路径已更新', 'success')
    }
    catch (err) {
      showToast(err instanceof Error ? err.message : '重命名失败', 'error')
    }
  }

  function insertTextAtCursor(before: string, after = '', placeholder = ''): void {
    const start = bodyTextarea.selectionStart
    const end = bodyTextarea.selectionEnd
    const selected = bodyTextarea.value.slice(start, end)
    const content = selected || placeholder
    const replacement = `${before}${content}${after}`

    bodyTextarea.focus()
    bodyTextarea.setRangeText(replacement, start, end, 'select')
    if (!selected && placeholder) {
      bodyTextarea.setSelectionRange(start + before.length, start + before.length + placeholder.length)
    }
    else {
      const caret = start + replacement.length
      bodyTextarea.setSelectionRange(caret, caret)
    }
    state.body = bodyTextarea.value
    setDirty(true)
    updateWordCount()
    schedulePreviewRender()
  }

  async function handleImageFiles(files: FileList | File[]): Promise<void> {
    if (!state.adapter || !state.activePath) {
      return
    }
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/') || /\.(?:png|jpe?g|webp|gif|svg|avif)$/i.test(f.name))
    if (imageFiles.length === 0) {
      return
    }

    const uploadedLines: string[] = []
    let hasPendingUpload = false
    for (const file of imageFiles) {
      try {
        showToast(`正在处理并上传图片 ${file.name || 'image'}...`, 'info')
        const res = await state.adapter.uploadImage(file, state.activePath)
        if (res.pending) {
          hasPendingUpload = true
        }
        const alt = (file.name || '图片').replace(/\.[^.]+$/, '')
        uploadedLines.push(`![${alt}](${res.markdownPath})`)
      }
      catch (err) {
        showToast(err instanceof Error ? err.message : '图片上传失败', 'error')
      }
    }

    updateModeUI()
    if (uploadedLines.length === 1) {
      insertTextAtCursor(`${uploadedLines[0]}\n`, '', '')
      showToast(
        hasPendingUpload ? '图片已压缩暂存（将在点击「提交发布」时随文章一并提交）' : '图片已上传并插入正文',
        'success',
      )
    }
    else if (uploadedLines.length > 1) {
      insertTextAtCursor(`\n:::grid\n${uploadedLines.join('\n')}\n:::\n`, '', '')
      showToast(
        hasPendingUpload
          ? `已压缩暂存 ${uploadedLines.length} 张图片并排入多宫格（提交发布时一次上传）`
          : `已上传 ${uploadedLines.length} 张图片并排入多宫格`,
        'success',
      )
    }
  }

  function wrapOrInsertImageContainer(kind: 'grid' | 'gallery'): void {
    const start = bodyTextarea.selectionStart
    const end = bodyTextarea.selectionEnd
    const selected = bodyTextarea.value.slice(start, end).trim()
    if (selected) {
      const directive = kind === 'grid' ? ':::grid[图集]' : ':::gallery[画廊]'
      insertTextAtCursor(`\n${directive}\n`, '\n:::\n')
      return
    }
    const sample = kind === 'grid'
      ? '\n:::grid[图集]\n![图 1](./_images/example-1.jpg)\n![图 2](./_images/example-2.jpg)\n![图 3](./_images/example-3.jpg)\n:::\n'
      : '\n:::gallery[画廊]\n![图 1](./_images/example-1.jpg)\n![图 2](./_images/example-2.jpg)\n:::\n'
    insertTextAtCursor(sample, '', '')
  }

  mediaUI = initAdminMediaUI({
    getAdapter: () => state.adapter,
    getActivePath: () => state.activePath,
    getBody: () => state.body,
    applyBodyChange: (nextBody, opts) => {
      state.body = nextBody
      bodyTextarea.value = nextBody
      setDirty(true)
      updateWordCount()
      schedulePreviewRender()
      if (opts?.selectRange) {
        if (state.viewMode === 'preview') {
          state.viewMode = 'split'
          updateViewModeUI()
        }
        bodyTextarea.focus()
        bodyTextarea.setSelectionRange(opts.selectRange[0], opts.selectRange[1])
        const beforeText = nextBody.slice(0, opts.selectRange[0])
        const lineIndex = beforeText.split('\n').length - 1
        bodyTextarea.scrollTop = Math.max(0, lineIndex * 22 - bodyTextarea.clientHeight / 3)
      }
    },
    insertAtCursor: (text) => {
      insertTextAtCursor(text, '', '')
    },
    onUploadFiles: files => handleImageFiles(files),
    askConfirm,
    showToast,
    bodyTextarea,
    previewPaneEl,
    previewBodyEl,
  })

  function buildSuggestedNewPostPath(title: string, lang: PostLang): string {
    const year = new Date().getFullYear()
    const cleanTitle = title
      .trim()
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || `post-${Date.now().toString(36)}`
    const suffix = lang ? `-${lang}` : ''
    return `src/content/posts/${year}/${cleanTitle}${suffix}.md`
  }

  function openNewPostModal(): void {
    newTitleInput.value = ''
    newLangSelect.value = 'zh'
    newPathManual = false
    newPathInput.value = buildSuggestedNewPostPath('untitled', 'zh')
    newModalEl.classList.remove('hidden')
    newModalEl.classList.add('flex')
    newTitleInput.focus()
  }

  async function createNewPostFromModal(): Promise<void> {
    if (!state.adapter) {
      return
    }
    const title = newTitleInput.value.trim()
    if (!title) {
      showToast('请输入文章标题', 'error')
      return
    }
    const rawLang = newLangSelect.value
    const lang: PostLang = rawLang === 'zh' || rawLang === 'en' ? rawLang : ''
    let targetPath = newPathInput.value.trim().replace(/\\/g, '/').replace(/^\/+/, '')
    if (!targetPath.startsWith('src/content/posts/')) {
      targetPath = `src/content/posts/${targetPath}`
    }
    if (!/\.(?:md|mdx)$/i.test(targetPath)) {
      targetPath = `${targetPath}.md`
    }
    if (state.files.some(f => f.path === targetPath)) {
      showToast('该路径已存在文件，请修改文件名', 'error')
      return
    }

    if (state.dirty && state.activePath) {
      const ok = await askConfirm('新建文章', '当前文章有未保存修改，确定放弃并新建吗？', '放弃并新建')
      if (!ok) {
        return
      }
    }

    const meta = createDefaultPostMeta(lang, title)
    meta.abbrlink = suggestSlug(title)
    const body = '在这里开始写正文……\n'
    const serialized = serializeMarkdownFile(meta, body, 'post')

    if (state.adapter.mode === 'github') {
      draftFiles.set(targetPath, {
        path: targetPath,
        kind: 'post',
        content: serialized,
        meta,
        body,
      })
      state.files.push({
        path: targetPath,
        kind: 'post',
        meta: { ...meta, tags: [...meta.tags], extra: { ...meta.extra } },
      })
      newModalEl.classList.add('hidden')
      newModalEl.classList.remove('flex')
      await openFile(targetPath, true)
      bodyTextarea.focus()
      bodyTextarea.setSelectionRange(0, bodyTextarea.value.length)
      showToast('已在草稿区创建文章，写完后点击「提交发布」一次上线', 'success')
      return
    }

    try {
      await state.adapter.saveFile(targetPath, serialized, {
        commitMessage: `post: create ${title}`,
      })
      newModalEl.classList.add('hidden')
      newModalEl.classList.remove('flex')
      await refreshFileList(targetPath)
      showToast('新文章已创建', 'success')
    }
    catch (err) {
      showToast(err instanceof Error ? err.message : '创建文章失败', 'error')
    }
  }

  async function handlePairLanguage(): Promise<void> {
    if (!state.adapter || !state.activePath) {
      return
    }
    const targetPathAttr = pairLangBtn.dataset.targetPath || ''
    if (targetPathAttr) {
      await openFile(targetPathAttr)
      return
    }

    readInputsToMeta()
    if (!state.meta.abbrlink) {
      state.meta.abbrlink = suggestSlug(state.meta.title)
      inputAbbrlink.value = state.meta.abbrlink
    }
    const saved = await saveCurrentFile()
    if (!saved) {
      return
    }

    const targetLang: PostLang = state.meta.lang === 'zh' ? 'en' : 'zh'
    const baseNoExt = state.activePath.replace(/\.(?:md|mdx)$/i, '')
    const stripped = baseNoExt.replace(/-(?:zh|en)$/i, '')
    const siblingPath = `${stripped}-${targetLang}.md`

    if (state.files.some(f => f.path === siblingPath)) {
      await openFile(siblingPath)
      return
    }

    const siblingMeta: PostMeta = {
      ...createDefaultPostMeta(targetLang, state.meta.title),
      published: state.meta.published || getTodayDateString(),
      pin: state.meta.pin,
      toc: state.meta.toc,
      abbrlink: state.meta.abbrlink,
    }
    const siblingBody = targetLang === 'en'
      ? `<!-- Translated from ${state.activePath} -->\n\n${state.body}`
      : state.body
    const serialized = serializeMarkdownFile(siblingMeta, siblingBody, 'post')

    try {
      await state.adapter.saveFile(siblingPath, serialized, {
        commitMessage: `post: create ${targetLang} version of ${state.meta.abbrlink}`,
      })
      await refreshFileList(siblingPath)
      showToast(`已创建${targetLang === 'en' ? '英文' : '中文'}对照版本`, 'success')
    }
    catch (err) {
      showToast(err instanceof Error ? err.message : '创建对照版本失败', 'error')
    }
  }

  function openGitHubModal(): void {
    const cfg = loadGitHubConfig()
    ghRepoInput.value = cfg.owner && cfg.repo ? `${cfg.owner}/${cfg.repo}` : ''
    ghBranchInput.value = cfg.branch || 'main'
    ghTokenInput.value = cfg.token
    ghStatusEl.textContent = ''
    ghModalEl.classList.remove('hidden')
    ghModalEl.classList.add('flex')
  }

  function closeGitHubModal(): void {
    ghModalEl.classList.add('hidden')
    ghModalEl.classList.remove('flex')
  }

  function parseGitHubModalInputs() {
    const repoText = ghRepoInput.value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
    const parts = repoText.split('/').filter(Boolean)
    if (parts.length !== 2) {
      throw new Error('仓库格式需为 用户名/仓库名（例如 yourname/blog）')
    }
    const branch = ghBranchInput.value.trim() || 'main'
    const token = ghTokenInput.value.trim()
    if (!token) {
      throw new Error('请输入 GitHub Fine-Grained Token')
    }
    return {
      owner: parts[0],
      repo: parts[1],
      branch,
      token,
    }
  }

  // Event wiring
  toggleSidebarBtn.addEventListener('click', () => {
    state.sidebarOpen = !state.sidebarOpen
    updateSidebarUI()
  })

  themeToggleBtn.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark')
    localStorage.setItem('theme', isDark ? 'dark' : 'light')
  })

  modeBadgeBtn.addEventListener('click', () => openGitHubModal())
  saveBtn.addEventListener('click', () => void saveCurrentFile())
  newPostOpenBtn.addEventListener('click', () => openNewPostModal())

  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value
    renderFileLists()
  })

  for (const btn of filterBtns) {
    btn.addEventListener('click', () => {
      state.filter = (btn.dataset.filter as FilterKind) || 'all'
      for (const b of filterBtns) {
        const active = b === btn
        b.classList.toggle('bg-highlight', active)
        b.classList.toggle('c-primary', active)
        b.classList.toggle('font-medium', active)
      }
      renderFileLists()
    })
  }

  const handleListClick = (ev: Event) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-open-path]')
    const filePath = target?.dataset.openPath
    if (filePath) {
      void openFile(filePath)
    }
  }
  postListEl.addEventListener('click', handleListClick)
  aboutListEl.addEventListener('click', handleListClick)

  metaPanelToggleBtn.addEventListener('click', () => {
    state.metaOpen = !state.metaOpen
    metaFieldsEl.classList.toggle('hidden', !state.metaOpen)
    metaPanelToggleBtn.textContent = state.metaOpen ? '收起文章信息' : '展开文章信息'
  })

  const metaInputs: HTMLElement[] = [
    inputTitle,
    inputPublished,
    inputUpdated,
    inputLang,
    inputAbbrlink,
    inputTags,
    inputPin,
    inputDraft,
    inputToc,
    inputDescription,
  ]
  for (const input of metaInputs) {
    input.addEventListener('input', () => {
      readInputsToMeta()
      setDirty(true)
      updatePostActionButtons()
      schedulePreviewRender()
    })
    input.addEventListener('change', () => {
      readInputsToMeta()
      setDirty(true)
      updatePostActionButtons()
      schedulePreviewRender()
    })
  }

  genSlugBtn.addEventListener('click', () => {
    inputAbbrlink.value = suggestSlug(inputTitle.value)
    readInputsToMeta()
    setDirty(true)
    updatePostActionButtons()
  })

  pairLangBtn.addEventListener('click', () => void handlePairLanguage())
  deletePostBtn.addEventListener('click', () => void deleteCurrentPost())

  for (const btn of viewModeBtns) {
    btn.addEventListener('click', () => {
      state.viewMode = (btn.dataset.viewMode as ViewMode) || 'split'
      updateViewModeUI()
      if (state.viewMode !== 'edit') {
        void renderPreviewNow()
      }
    })
  }

  for (const btn of toolbarActionBtns) {
    btn.addEventListener('click', () => {
      const action = btn.dataset.mdAction
      switch (action) {
        case 'bold':
          insertTextAtCursor('**', '**', '加粗文字')
          break
        case 'italic':
          insertTextAtCursor('*', '*', '斜体文字')
          break
        case 'h2':
          insertTextAtCursor('## ', '', '二级标题')
          break
        case 'h3':
          insertTextAtCursor('### ', '', '三级标题')
          break
        case 'quote':
          insertTextAtCursor('> ', '', '引用内容')
          break
        case 'code':
          insertTextAtCursor('```ts\n', '\n```', 'console.log("hello")')
          break
        case 'math':
          insertTextAtCursor('$$\n', '\n$$', 'E = mc^2')
          break
        case 'link':
          insertTextAtCursor('[', '](https://)', '链接文字')
          break
      }
    })
  }

  uploadImgBtn.addEventListener('click', () => uploadImgInput.click())
  mediaLibraryBtn.addEventListener('click', () => void mediaUI?.openMediaLibrary())
  insertGridBtn.addEventListener('click', () => wrapOrInsertImageContainer('grid'))
  insertGalleryBtn.addEventListener('click', () => wrapOrInsertImageContainer('gallery'))
  uploadImgInput.addEventListener('change', () => {
    if (uploadImgInput.files && uploadImgInput.files.length > 0) {
      void handleImageFiles(uploadImgInput.files)
      uploadImgInput.value = ''
    }
  })

  formatBtn.addEventListener('click', () => void formatEditorBody())

  bodyTextarea.addEventListener('input', () => {
    state.body = bodyTextarea.value
    setDirty(true)
    updateWordCount()
    schedulePreviewRender()
  })

  bodyTextarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab') {
      ev.preventDefault()
      insertTextAtCursor('  ', '', '')
    }
  })

  bodyTextarea.addEventListener('paste', (ev) => {
    const items = ev.clipboardData?.files
    if (items && items.length > 0) {
      const hasImg = Array.from(items).some(f => f.type.startsWith('image/'))
      if (hasImg) {
        ev.preventDefault()
        void handleImageFiles(items)
      }
    }
  })

  bodyTextarea.addEventListener('dragover', (ev) => {
    if (ev.dataTransfer?.types.includes('Files')) {
      ev.preventDefault()
    }
  })

  bodyTextarea.addEventListener('drop', (ev) => {
    const files = ev.dataTransfer?.files
    if (files && files.length > 0) {
      const hasImg = Array.from(files).some(f => f.type.startsWith('image/'))
      if (hasImg) {
        ev.preventDefault()
        void handleImageFiles(files)
      }
    }
  })

  // Keyboard shortcuts
  window.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      void saveCurrentFile()
    }
  })

  window.addEventListener('beforeunload', (ev) => {
    if (state.dirty) {
      ev.preventDefault()
    }
  })

  // New post modal events
  newTitleInput.addEventListener('input', () => {
    if (!newPathManual) {
      const rawLang = newLangSelect.value
      const lang: PostLang = rawLang === 'zh' || rawLang === 'en' ? rawLang : ''
      newPathInput.value = buildSuggestedNewPostPath(newTitleInput.value, lang)
    }
  })
  newLangSelect.addEventListener('change', () => {
    if (!newPathManual) {
      const rawLang = newLangSelect.value
      const lang: PostLang = rawLang === 'zh' || rawLang === 'en' ? rawLang : ''
      newPathInput.value = buildSuggestedNewPostPath(newTitleInput.value, lang)
    }
  })
  newPathInput.addEventListener('input', () => {
    newPathManual = true
  })
  newCancelBtn.addEventListener('click', () => {
    newModalEl.classList.add('hidden')
    newModalEl.classList.remove('flex')
  })
  newCreateBtn.addEventListener('click', () => void createNewPostFromModal())

  // GitHub modal events
  ghCloseBtn.addEventListener('click', () => closeGitHubModal())
  ghTestBtn.addEventListener('click', async () => {
    try {
      const cfg = parseGitHubModalInputs()
      ghStatusEl.textContent = '正在测试连接...'
      const gh = new GitHubStorageAdapter(cfg)
      const info = await gh.verifyConnection()
      ghStatusEl.textContent = info.canPush
        ? `连接成功：${info.fullName}（具备写入权限）`
        : `已连接 ${info.fullName}，但当前 Token 似乎缺少写入权限`
    }
    catch (err) {
      ghStatusEl.textContent = err instanceof Error ? err.message : '连接测试失败'
    }
  })

  ghSaveBtn.addEventListener('click', async () => {
    try {
      const cfg = parseGitHubModalInputs()
      ghStatusEl.textContent = '正在验证并加载仓库文章...'
      const gh = new GitHubStorageAdapter(cfg)
      await gh.verifyConnection()
      saveGitHubConfig(cfg)
      state.adapter?.clearPendingUploads?.()
      draftFiles.clear()
      state.adapter = gh
      state.activePath = null
      setDirty(false)
      updateModeUI()
      closeGitHubModal()
      await refreshFileList()
      showToast('已切换到 GitHub 线上写作模式', 'success')
    }
    catch (err) {
      ghStatusEl.textContent = err instanceof Error ? err.message : '连接 GitHub 失败'
    }
  })

  ghSwitchLocalBtn.addEventListener('click', async () => {
    if (!state.localAvailable) {
      return
    }
    state.adapter?.clearPendingUploads?.()
    draftFiles.clear()
    state.adapter = new LocalStorageAdapter()
    state.activePath = null
    setDirty(false)
    updateModeUI()
    closeGitHubModal()
    await refreshFileList()
    showToast('已切回本地文件模式', 'success')
  })

  ghClearBtn.addEventListener('click', () => {
    clearGitHubConfig()
    ghTokenInput.value = ''
    ghStatusEl.textContent = '已清除本地浏览器保存的 Token'
  })

  renameCancelBtn.addEventListener('click', () => {
    renameModalEl.classList.add('hidden')
    renameModalEl.classList.remove('flex')
    renameSourcePath = null
  })
  renameConfirmBtn.addEventListener('click', () => void confirmRenamePost())

  // Custom Context Menu
  type ContextMenuItem
    = | { type: 'divider' }
      | { type: 'item', label: string, shortcut?: string, danger?: boolean, onClick: () => unknown }

  function closeContextMenu(): void {
    contextMenuEl.classList.add('hidden')
    contextMenuEl.innerHTML = ''
  }

  function openContextMenu(clientX: number, clientY: number, items: ContextMenuItem[]): void {
    contextMenuEl.innerHTML = ''
    for (const item of items) {
      if (item.type === 'divider') {
        const div = document.createElement('div')
        div.className = 'ctx-divider'
        contextMenuEl.appendChild(div)
        continue
      }

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('role', 'menuitem')
      btn.className = item.danger ? 'ctx-item ctx-danger' : 'ctx-item'

      const labelSpan = document.createElement('span')
      labelSpan.textContent = item.label
      btn.appendChild(labelSpan)

      if (item.shortcut) {
        const keySpan = document.createElement('span')
        keySpan.className = 'text-[11px] opacity-60 font-mono'
        keySpan.textContent = item.shortcut
        btn.appendChild(keySpan)
      }

      btn.addEventListener('click', () => {
        closeContextMenu()
        void item.onClick()
      })
      contextMenuEl.appendChild(btn)
    }

    contextMenuEl.style.left = '0px'
    contextMenuEl.style.top = '0px'
    contextMenuEl.classList.remove('hidden')

    const rect = contextMenuEl.getBoundingClientRect()
    const clampedX = Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8))
    const clampedY = Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8))
    contextMenuEl.style.left = `${clampedX}px`
    contextMenuEl.style.top = `${clampedY}px`
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      showToast(`已复制链接：${text}`, 'success')
    }
    catch {
      showToast(`链接：${text}`, 'info')
    }
  }

  postListEl.addEventListener('contextmenu', (ev) => {
    if (ev.shiftKey) {
      return
    }
    const targetBtn = (ev.target as HTMLElement).closest<HTMLElement>('[data-open-path]')
    const filePath = targetBtn?.dataset.openPath
    if (!filePath) {
      return
    }
    const summary = state.files.find(f => f.path === filePath)
    if (!summary) {
      return
    }

    ev.preventDefault()
    ev.stopPropagation()

    const sibling = findSiblingTranslation(summary.path, summary.meta)
    const items: ContextMenuItem[] = [
      {
        type: 'item',
        label: '打开编辑',
        onClick: () => openFile(summary.path),
      },
      {
        type: 'item',
        label: '新标签页查看 ↗',
        onClick: () => {
          window.open(computePostRoute(summary.path, summary.meta), '_blank', 'noopener')
        },
      },
      {
        type: 'item',
        label: '复制文章链接',
        onClick: () => copyText(new URL(computePostRoute(summary.path, summary.meta), window.location.origin).href),
      },
    ]

    if (summary.meta.lang === 'zh' || summary.meta.lang === 'en') {
      items.push({
        type: 'item',
        label: sibling
          ? (summary.meta.lang === 'zh' ? '切换英文版' : '切换中文版')
          : (summary.meta.lang === 'zh' ? '创建英文版' : '创建中文版'),
        onClick: async () => {
          if (sibling) {
            await openFile(sibling.path)
          }
          else {
            if (state.activePath !== summary.path) {
              await openFile(summary.path)
            }
            await handlePairLanguage()
          }
        },
      })
    }

    items.push(
      { type: 'divider' },
      {
        type: 'item',
        label: summary.meta.pin > 0 ? '取消置顶' : '置顶文章',
        onClick: () => togglePostFlag(summary.path, 'pin'),
      },
      {
        type: 'item',
        label: summary.meta.draft ? '取消草稿' : '设为草稿',
        onClick: () => togglePostFlag(summary.path, 'draft'),
      },
      {
        type: 'item',
        label: '复制为副本',
        onClick: () => duplicatePost(summary.path),
      },
      { type: 'divider' },
      {
        type: 'item',
        label: '重命名 / 移动路径',
        onClick: () => openRenameModal(summary.path),
      },
      {
        type: 'item',
        label: '删除文章',
        danger: true,
        onClick: () => deletePostByPath(summary.path, summary.meta.title || summary.path),
      },
    )

    openContextMenu(ev.clientX, ev.clientY, items)
  })

  aboutListEl.addEventListener('contextmenu', (ev) => {
    if (ev.shiftKey) {
      return
    }
    const targetBtn = (ev.target as HTMLElement).closest<HTMLElement>('[data-open-path]')
    const filePath = targetBtn?.dataset.openPath
    if (!filePath) {
      return
    }
    ev.preventDefault()
    ev.stopPropagation()
    const isEn = filePath.includes('-en')
    openContextMenu(ev.clientX, ev.clientY, [
      {
        type: 'item',
        label: '打开编辑',
        onClick: () => openFile(filePath),
      },
      {
        type: 'item',
        label: '新标签页查看 ↗',
        onClick: () => {
          window.open(isEn ? `${base}/en/about/` : `${base}/about/`, '_blank', 'noopener')
        },
      },
    ])
  })

  sidebarEl.addEventListener('contextmenu', (ev) => {
    if (ev.shiftKey) {
      return
    }
    const target = ev.target as HTMLElement
    if (target.closest('[data-open-path]') || target.closest('input, button, select')) {
      return
    }
    ev.preventDefault()
    openContextMenu(ev.clientX, ev.clientY, [
      {
        type: 'item',
        label: '新建文章',
        onClick: () => openNewPostModal(),
      },
      {
        type: 'item',
        label: '刷新文章列表',
        onClick: async () => {
          await refreshFileList(state.activePath || undefined)
          showToast('文章列表已刷新', 'info')
        },
      },
      {
        type: 'item',
        label: '收起目录栏',
        onClick: () => {
          state.sidebarOpen = false
          updateSidebarUI()
        },
      },
    ])
  })

  bodyTextarea.addEventListener('contextmenu', (ev) => {
    if (ev.shiftKey) {
      return
    }
    ev.preventDefault()
    const items: ContextMenuItem[] = [
      { type: 'item', label: '加粗', shortcut: '**', onClick: () => insertTextAtCursor('**', '**', '加粗文字') },
      { type: 'item', label: '斜体', shortcut: '*', onClick: () => insertTextAtCursor('*', '*', '斜体文字') },
      { type: 'item', label: '行内代码', shortcut: '`', onClick: () => insertTextAtCursor('`', '`', 'code') },
      { type: 'item', label: '插入链接', shortcut: '[]()', onClick: () => insertTextAtCursor('[', '](https://)', '链接文字') },
      { type: 'item', label: '插入引用', shortcut: '>', onClick: () => insertTextAtCursor('> ', '', '引用内容') },
      { type: 'item', label: '插入代码块', shortcut: '```', onClick: () => insertTextAtCursor('```ts\n', '\n```', 'console.log("hello")') },
      { type: 'item', label: '插入数学公式', shortcut: '$$', onClick: () => insertTextAtCursor('$$\n', '\n$$', 'E = mc^2') },
      { type: 'divider' },
      { type: 'item', label: '上传并插入图片', onClick: () => uploadImgInput.click() },
      { type: 'item', label: '打开图片素材库', onClick: () => mediaUI?.openMediaLibrary() },
      { type: 'item', label: '插入宽幅大图', onClick: () => insertTextAtCursor('![图注](./_images/example.jpg "wide")\n', '', '') },
      { type: 'item', label: '插入竖图伴读', onClick: () => insertTextAtCursor('![要点说明 | 正文描述](./_images/example.jpg "compact")\n', '', '') },
      { type: 'item', label: '包装 / 插入多宫格', onClick: () => wrapOrInsertImageContainer('grid') },
      { type: 'item', label: '包装 / 插入舞台画廊', onClick: () => wrapOrInsertImageContainer('gallery') },
    ]
    if (state.adapter?.formatBody) {
      items.push({ type: 'item', label: '排版中英文空格', onClick: () => formatEditorBody() })
    }
    items.push(
      { type: 'divider' },
      { type: 'item', label: '保存文章', shortcut: 'Ctrl+S', onClick: () => saveCurrentFile() },
    )
    openContextMenu(ev.clientX, ev.clientY, items)
  })

  document.addEventListener('pointerdown', (ev) => {
    if (!contextMenuEl.classList.contains('hidden') && !contextMenuEl.contains(ev.target as Node)) {
      closeContextMenu()
    }
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !contextMenuEl.classList.contains('hidden')) {
      closeContextMenu()
    }
  })
  window.addEventListener('resize', () => closeContextMenu())
  postListEl.addEventListener('scroll', () => closeContextMenu())
  bodyTextarea.addEventListener('scroll', () => closeContextMenu())

  // Bootstrap
  async function bootstrap(): Promise<void> {
    updateSidebarUI()
    updateViewModeUI()

    const localStatus = await detectLocalMode()
    state.localAvailable = localStatus.available
    state.formatSupported = localStatus.formatSupported

    if (localStatus.available) {
      state.adapter = new LocalStorageAdapter()
      updateModeUI()
      await refreshFileList()
      return
    }

    const savedGh = loadGitHubConfig()
    if (savedGh.owner && savedGh.repo && savedGh.token) {
      state.adapter = new GitHubStorageAdapter(savedGh)
      updateModeUI()
      try {
        await refreshFileList()
        return
      }
      catch (err) {
        showToast(err instanceof Error ? err.message : 'GitHub Token 验证失败，请重新配置', 'error')
      }
    }
    else {
      state.adapter = new GitHubStorageAdapter(savedGh)
      updateModeUI()
    }

    openGitHubModal()
  }

  // Expose minimal parser check for debugging if needed without unused import warning
  void parseMarkdownFile
  void bootstrap()
}

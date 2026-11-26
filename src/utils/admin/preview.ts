import type { StorageAdapter } from './storage'
import katex from 'katex'
import MarkdownIt from 'markdown-it'
import { normalizeImageTier } from './media-ui'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
})

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildImgSrcAttr(src: string): string {
  const isRemote = /^(?:https?:|data:|blob:|\/)/i.test(src)
  return isRemote ? `src="${escapeHtml(src)}"` : `data-rel-src="${escapeHtml(src)}"`
}

interface ParsedDirectiveImage {
  src: string
  cleanAlt: string
  skipCaption: boolean
}

function extractImagesFromDirectiveBody(blockBody: string): ParsedDirectiveImage[] {
  const regex = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g
  const imgs: ParsedDirectiveImage[] = []
  let match = regex.exec(blockBody)
  while (match !== null) {
    const rawAlt = match[1] || ''
    const src = match[2] || ''
    const skipCaption = !rawAlt || rawAlt.startsWith('_')
    const cleanAlt = rawAlt.startsWith('_') ? rawAlt.slice(1) : rawAlt
    imgs.push({ src, cleanAlt, skipCaption })
    match = regex.exec(blockBody)
  }
  return imgs
}

function parseDirectiveAttributes(rawAttrs: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {}
  if (!rawAttrs) {
    return attrs
  }
  const regex = /(\w+)\s*=\s*"([^"]*)"/g
  let match = regex.exec(rawAttrs)
  while (match !== null) {
    attrs[match[1]] = match[2]
    match = regex.exec(rawAttrs)
  }
  return attrs
}

function renderGridDirectiveHtml(title: string, colsAttr: string | undefined, imgs: ParsedDirectiveImage[]): string {
  const colStr = (colsAttr || '').trim()
  const resolvedCols = colStr === '2' || colStr === '3' || colStr === '4'
    ? colStr
    : imgs.length <= 1
      ? '1'
      : imgs.length === 2 || imgs.length === 4
        ? '2'
        : '3'

  const tilesHtml = imgs.map((img, idx) => {
    const num = String(idx + 1).padStart(2, '0')
    const captionHtml = img.skipCaption
      ? ''
      : `<figcaption class="img-grid-tile-caption">${escapeHtml(img.cleanAlt)}</figcaption>`
    return `<figure class="img-grid-tile"><img ${buildImgSrcAttr(img.src)} alt="${escapeHtml(img.cleanAlt)}" loading="lazy" /><span class="img-grid-badge" aria-hidden="true">${num}</span>${captionHtml}</figure>`
  }).join('')

  return `<div class="gallery-container img-grid-container" data-gallery-mode="grid" data-grid-cols="${resolvedCols}"><div class="img-grid">${tilesHtml}</div><div class="img-grid-footer"><span class="img-grid-title">${escapeHtml(title || '图集')}</span><span class="img-grid-count">${imgs.length} 幅 · 点击放大</span></div></div>`
}

function renderStageDirectiveHtml(title: string, imgs: ParsedDirectiveImage[]): string {
  if (imgs.length === 1) {
    const first = imgs[0]
    const figCaption = first.skipCaption ? '' : `<figcaption>${escapeHtml(first.cleanAlt)}</figcaption>`
    return `<figure class="img-figure" data-tier="standard"><img ${buildImgSrcAttr(first.src)} alt="${escapeHtml(first.cleanAlt)}" loading="lazy" />${figCaption}</figure>`
  }

  const first = imgs[0]
  const firstCaption = (!first.skipCaption && first.cleanAlt) || title || '图 1'
  const thumbsHtml = imgs.map((img, idx) => {
    const caption = img.skipCaption ? '' : img.cleanAlt
    const activeAttr = idx === 0 ? ' data-active=""' : ''
    return `<button type="button" class="img-thumb-btn" role="tab" aria-selected="${idx === 0 ? 'true' : 'false'}"${activeAttr} data-stage-thumb="" data-index="${idx}" data-caption="${escapeHtml(caption)}"><img ${buildImgSrcAttr(img.src)} alt="${escapeHtml(img.cleanAlt)}" loading="lazy" /><span class="img-thumb-bar" aria-hidden="true"></span></button>`
  }).join('')

  return `<div class="gallery-container" data-gallery-mode="stage"><div class="img-stage-frame"><img class="img-stage-img" ${buildImgSrcAttr(first.src)} alt="${escapeHtml(first.cleanAlt)}" data-stage-hero="true" loading="lazy" /></div><div class="img-stage-meta"><p class="img-stage-caption" data-stage-caption="">${escapeHtml(firstCaption)}</p><span class="img-stage-count" data-stage-count="">1 / ${imgs.length}</span></div><div class="img-thumb-rail" role="tablist" aria-label="画廊缩略图切换">${thumbsHtml}</div></div>`
}

let activeImageOccurrence = 0

md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx]
  const src = token.attrGet('src') || ''
  const alt = token.content || ''
  const tier = normalizeImageTier(token.attrGet('title'))
  const skipCaption = !alt || alt.startsWith('_')
  const cleanAlt = alt.startsWith('_') ? alt.slice(1) : alt
  const occurrenceIdx = activeImageOccurrence
  activeImageOccurrence += 1
  const imgTag = `<img ${buildImgSrcAttr(src)} alt="${escapeHtml(cleanAlt)}" data-admin-img-idx="${occurrenceIdx}" loading="lazy" />`

  if (tier === 'compact') {
    let asideHtml = ''
    if (!skipCaption) {
      const pipeIdx = cleanAlt.indexOf('|')
      asideHtml = pipeIdx > 0
        ? `<figcaption class="img-compact-aside"><span class="img-compact-kicker">${escapeHtml(cleanAlt.slice(0, pipeIdx).trim())}</span><p class="img-compact-text">${escapeHtml(cleanAlt.slice(pipeIdx + 1).trim())}</p></figcaption>`
        : `<figcaption class="img-compact-aside"><p class="img-compact-text">${escapeHtml(cleanAlt)}</p></figcaption>`
    }
    return `<figure class="img-figure" data-tier="compact"><div class="img-compact-media">${imgTag}</div>${asideHtml}</figure>`
  }

  if (skipCaption && tier !== 'wide') {
    return imgTag
  }

  const captionHtml = skipCaption ? '' : `<figcaption>${escapeHtml(cleanAlt)}</figcaption>`
  return `<figure class="img-figure" data-tier="${tier}">${imgTag}${captionHtml}</figure>`
}

function renderMathToken(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode,
      throwOnError: false,
    })
  }
  catch {
    return escapeHtml(tex)
  }
}

export function renderMarkdownPreview(rawBody: string): string {
  activeImageOccurrence = 0
  const protectedBlocks: string[] = []
  const mathReplacements: string[] = []
  const directiveReplacements: string[] = []

  const protect = (segment: string) => {
    const idx = protectedBlocks.length
    protectedBlocks.push(segment)
    return `@@PROTECTED_${idx}@@`
  }

  // 1. Protect fenced code blocks and inline code spans first
  let working = rawBody.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, match => protect(match))
  working = working.replace(/`[^`\n]+`/g, match => protect(match))

  // 2. Transform :::grid and :::gallery directives outside protected code blocks
  working = working.replace(
    /^:::(grid|gallery)(?:\[([^\]]*)\])?(?:\{([^}]*)\})?[ \t]*\r?\n([\s\S]*?)\r?\n:::[ \t]*$/gm,
    (fullMatch, type: string, rawTitle: string | undefined, rawAttrs: string | undefined, innerBody: string) => {
      const imgs = extractImagesFromDirectiveBody(innerBody)
      if (imgs.length === 0) {
        return fullMatch
      }
      const title = (rawTitle || '').trim()
      const attrs = parseDirectiveAttributes(rawAttrs)
      const isGrid = type === 'grid' || attrs.mode === 'grid'
      const idx = directiveReplacements.length
      directiveReplacements.push(
        isGrid
          ? renderGridDirectiveHtml(title, attrs.cols, imgs)
          : renderStageDirectiveHtml(title, imgs),
      )
      return `\n\n@@DIRECTIVE_${idx}@@\n\n`
    },
  )

  // 3. Replace display math $$...$$
  working = working.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => {
    const idx = mathReplacements.length
    mathReplacements.push(`<div class="my-4 overflow-x-auto">${renderMathToken(tex, true)}</div>`)
    return `\n\n@@MATH_${idx}@@\n\n`
  })

  // 4. Replace inline math $...$
  working = working.replace(/(^|[^\\$])\$([^\n$]+)\$/g, (_, prefix: string, tex: string) => {
    const idx = mathReplacements.length
    mathReplacements.push(renderMathToken(tex, false))
    return `${prefix}@@MATH_${idx}@@`
  })

  // 5. Restore protected code blocks
  working = working.replace(/@@PROTECTED_(\d+)@@/g, (_, idxStr: string) => {
    return protectedBlocks[Number.parseInt(idxStr, 10)] || ''
  })

  let html = md.render(working)

  // 6. Restore rendered :::grid / :::gallery HTML blocks
  html = html.replace(/<p>@@DIRECTIVE_(\d+)@@<\/p>/g, (_, idxStr: string) => {
    return directiveReplacements[Number.parseInt(idxStr, 10)] || ''
  })
  html = html.replace(/@@DIRECTIVE_(\d+)@@/g, (_, idxStr: string) => {
    return directiveReplacements[Number.parseInt(idxStr, 10)] || ''
  })

  // 7. Restore KaTeX HTML
  html = html.replace(/<p>@@MATH_(\d+)@@<\/p>/g, (_, idxStr: string) => {
    return mathReplacements[Number.parseInt(idxStr, 10)] || ''
  })
  html = html.replace(/@@MATH_(\d+)@@/g, (_, idxStr: string) => {
    return mathReplacements[Number.parseInt(idxStr, 10)] || ''
  })

  return html
}

export async function hydratePreviewImages(
  container: HTMLElement,
  postPath: string,
  adapter: StorageAdapter,
): Promise<void> {
  const imgs = Array.from(container.querySelectorAll<HTMLImageElement>('img[data-rel-src]'))
  await Promise.all(
    imgs.map(async (img) => {
      const relSrc = img.getAttribute('data-rel-src')
      if (!relSrc) {
        return
      }
      const resolvedUrl = await adapter.resolveImagePreviewUrl(relSrc, postPath)
      if (resolvedUrl) {
        img.src = resolvedUrl
      }
    }),
  )
}

export function wirePreviewStageGalleries(container: HTMLElement): void {
  const containers = Array.from(container.querySelectorAll<HTMLElement>('.gallery-container[data-gallery-mode="stage"]'))
  for (const gallery of containers) {
    const hero = gallery.querySelector<HTMLImageElement>('[data-stage-hero], .img-stage-frame img')
    const captionEl = gallery.querySelector<HTMLElement>('[data-stage-caption], .img-stage-caption')
    const countEl = gallery.querySelector<HTMLElement>('[data-stage-count], .img-stage-count')
    const thumbs = Array.from(gallery.querySelectorAll<HTMLButtonElement>('[data-stage-thumb], .img-thumb-btn'))

    if (!hero || !captionEl || !countEl || thumbs.length === 0) {
      continue
    }

    thumbs.forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const thumbImg = btn.querySelector<HTMLImageElement>('img')
        const nextSrc = thumbImg?.currentSrc || thumbImg?.src || ''
        if (!nextSrc) {
          return
        }
        const caption = btn.dataset.caption !== undefined ? btn.dataset.caption : (thumbImg?.alt || '')
        hero.removeAttribute('srcset')
        hero.src = nextSrc
        hero.alt = thumbImg?.alt || caption
        if (thumbImg?.dataset.relSrc) {
          hero.dataset.relSrc = thumbImg.dataset.relSrc
        }
        captionEl.textContent = caption || `图 ${idx + 1}`
        countEl.textContent = `${idx + 1} / ${thumbs.length}`
        thumbs.forEach((other, j) => {
          other.toggleAttribute('data-active', j === idx)
          other.setAttribute('aria-selected', j === idx ? 'true' : 'false')
        })
      })
    })
  }
}

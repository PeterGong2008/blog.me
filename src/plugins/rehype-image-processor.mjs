import { visit } from 'unist-util-visit'

function hasClass(node, className) {
  const classes = node?.properties?.className
  return Array.isArray(classes) && classes.includes(className)
}

function parseImageMeta(imgNode) {
  imgNode.properties ??= {}
  const rawAlt = typeof imgNode.properties.alt === 'string' ? imgNode.properties.alt : ''
  const rawTitle = typeof imgNode.properties.title === 'string'
    ? imgNode.properties.title.trim().toLowerCase()
    : ''

  const skipCaption = !rawAlt || rawAlt.startsWith('_')
  const cleanCaption = rawAlt.startsWith('_') ? rawAlt.slice(1) : rawAlt
  const tier = rawTitle === 'wide' || rawTitle === 'compact' ? rawTitle : 'standard'

  if (rawTitle === 'wide' || rawTitle === 'compact') {
    delete imgNode.properties.title
  }

  if (skipCaption) {
    delete imgNode.properties['data-caption']
    imgNode.properties['data-caption-hidden'] = 'true'
  }
  else {
    imgNode.properties['data-caption'] = cleanCaption
    delete imgNode.properties['data-caption-hidden']
  }
  return {
    skipCaption,
    cleanCaption,
    tier,
  }
}

function createSingleFigure(imgNode) {
  const { skipCaption, cleanCaption, tier } = parseImageMeta(imgNode)

  if (tier === 'compact') {
    const mediaDiv = {
      type: 'element',
      tagName: 'div',
      properties: { className: ['img-compact-media'] },
      children: [imgNode],
    }
    const children = [mediaDiv]

    if (!skipCaption) {
      const pipeIdx = cleanCaption.indexOf('|')
      const asideChildren = pipeIdx > 0
        ? [
            {
              type: 'element',
              tagName: 'span',
              properties: { className: ['img-compact-kicker'] },
              children: [{ type: 'text', value: cleanCaption.slice(0, pipeIdx).trim() }],
            },
            {
              type: 'element',
              tagName: 'p',
              properties: { className: ['img-compact-text'] },
              children: [{ type: 'text', value: cleanCaption.slice(pipeIdx + 1).trim() }],
            },
          ]
        : [
            {
              type: 'element',
              tagName: 'p',
              properties: { className: ['img-compact-text'] },
              children: [{ type: 'text', value: cleanCaption }],
            },
          ]

      children.push({
        type: 'element',
        tagName: 'figcaption',
        properties: { className: ['img-compact-aside'] },
        children: asideChildren,
      })
    }

    return {
      type: 'element',
      tagName: 'figure',
      properties: {
        'className': ['img-figure'],
        'data-tier': 'compact',
      },
      children,
    }
  }

  if (skipCaption && tier !== 'wide') {
    return imgNode
  }

  const children = [imgNode]
  if (!skipCaption) {
    children.push({
      type: 'element',
      tagName: 'figcaption',
      properties: {},
      children: [{ type: 'text', value: cleanCaption }],
    })
  }

  return {
    type: 'element',
    tagName: 'figure',
    properties: {
      'className': ['img-figure'],
      'data-tier': tier,
    },
    children,
  }
}

function extractOnlyImagesFromParagraph(pNode) {
  if (pNode.tagName !== 'p' || !Array.isArray(pNode.children) || pNode.children.length === 0) {
    return null
  }
  const imgs = []
  for (const child of pNode.children) {
    if (child.type === 'element' && child.tagName === 'img') {
      imgs.push(child)
    }
    else if (child.type !== 'text' || child.value.trim() !== '') {
      return null
    }
  }
  return imgs.length > 0 ? imgs : null
}

function resolveGridCols(rawCols, imageCount) {
  if (rawCols === '2' || rawCols === '3' || rawCols === '4') {
    return rawCols
  }
  if (imageCount <= 1) {
    return '1'
  }
  if (imageCount === 2 || imageCount === 4) {
    return '2'
  }
  return '3'
}

export function rehypeImageProcessor() {
  return (tree) => {
    let gallerySeq = 0
    const processedGallerySet = new Set()

    // Pass 1: Process :::gallery (Focal Stage) and :::grid (Multi-Grid) containers
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'div' || !hasClass(node, 'gallery-container')) {
        return
      }
      processedGallerySet.add(node)

      const imgs = []
      const otherNodes = []
      for (const child of node.children ?? []) {
        if (child.type === 'element') {
          if (child.tagName === 'img') {
            imgs.push(child)
            continue
          }
          const pImgs = extractOnlyImagesFromParagraph(child)
          if (pImgs) {
            imgs.push(...pImgs)
            continue
          }
        }
        else if (child.type === 'text' && child.value.trim() === '') {
          continue
        }
        otherNodes.push(child)
      }

      if (imgs.length === 0) {
        return
      }

      gallerySeq += 1
      const mode = node.properties?.['data-gallery-mode'] === 'grid' ? 'grid' : 'stage'
      const title = typeof node.properties?.['data-gallery-title'] === 'string'
        ? node.properties['data-gallery-title'].trim()
        : ''

      if (mode === 'grid') {
        const groupId = `gallery-grid-${gallerySeq}`
        const resolvedCols = resolveGridCols(node.properties?.['data-grid-cols'], imgs.length)
        node.properties['data-grid-cols'] = resolvedCols

        const tiles = imgs.map((imgNode, idx) => {
          const { skipCaption, cleanCaption } = parseImageMeta(imgNode)
          imgNode.properties['data-gallery-group'] = groupId
          imgNode.properties['data-gallery-index'] = String(idx)

          const badge = {
            type: 'element',
            tagName: 'span',
            properties: {
              'className': ['img-grid-badge'],
              'aria-hidden': 'true',
            },
            children: [{ type: 'text', value: String(idx + 1).padStart(2, '0') }],
          }

          const tileChildren = [imgNode, badge]
          if (!skipCaption) {
            tileChildren.push({
              type: 'element',
              tagName: 'figcaption',
              properties: { className: ['img-grid-tile-caption'] },
              children: [{ type: 'text', value: cleanCaption }],
            })
          }

          return {
            type: 'element',
            tagName: 'figure',
            properties: { className: ['img-grid-tile'] },
            children: tileChildren,
          }
        })

        const gridEl = {
          type: 'element',
          tagName: 'div',
          properties: { className: ['img-grid'] },
          children: tiles,
        }

        const footerEl = {
          type: 'element',
          tagName: 'div',
          properties: { className: ['img-grid-footer'] },
          children: [
            {
              type: 'element',
              tagName: 'span',
              properties: { className: ['img-grid-title'] },
              children: [{ type: 'text', value: title || '图集' }],
            },
            {
              type: 'element',
              tagName: 'span',
              properties: { className: ['img-grid-count'] },
              children: [{ type: 'text', value: `${imgs.length} 幅 · 点击放大` }],
            },
          ],
        }

        node.children = [gridEl, footerEl, ...otherNodes]
        return
      }

      // Stage gallery mode (:::gallery default)
      if (imgs.length === 1) {
        node.children = [createSingleFigure(imgs[0]), ...otherNodes]
        return
      }

      const groupId = `gallery-stage-${gallerySeq}`
      const metas = imgs.map((imgNode, idx) => {
        const meta = parseImageMeta(imgNode)
        imgNode.properties['data-gallery-group'] = groupId
        imgNode.properties['data-gallery-index'] = String(idx)
        return meta
      })

      const firstImg = imgs[0]
      const firstMeta = metas[0]
      const heroProps = { ...firstImg.properties }
      if (Array.isArray(heroProps.className)) {
        heroProps.className = [...heroProps.className, 'img-stage-img']
      }
      else {
        heroProps.className = ['img-stage-img']
      }
      heroProps['data-stage-hero'] = 'true'
      heroProps['data-gallery-group'] = groupId
      heroProps['data-gallery-index'] = '0'
      if (firstMeta.skipCaption) {
        delete heroProps['data-caption']
        heroProps['data-caption-hidden'] = 'true'
      }
      else {
        heroProps['data-caption'] = firstMeta.cleanCaption
        delete heroProps['data-caption-hidden']
      }

      const heroImg = {
        ...firstImg,
        properties: heroProps,
      }

      const stageFrame = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['img-stage-frame'] },
        children: [heroImg],
      }

      const stageMeta = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['img-stage-meta'] },
        children: [
          {
            type: 'element',
            tagName: 'p',
            properties: {
              'className': ['img-stage-caption'],
              'data-stage-caption': '',
            },
            children: [{ type: 'text', value: (!firstMeta.skipCaption && firstMeta.cleanCaption) || title || '图 1' }],
          },
          {
            type: 'element',
            tagName: 'span',
            properties: {
              'className': ['img-stage-count'],
              'data-stage-count': '',
            },
            children: [{ type: 'text', value: `1 / ${imgs.length}` }],
          },
        ],
      }

      const thumbRail = {
        type: 'element',
        tagName: 'div',
        properties: {
          'className': ['img-thumb-rail'],
          'role': 'tablist',
          'aria-label': '画廊缩略图切换',
        },
        children: imgs.map((imgNode, idx) => {
          const meta = metas[idx]
          const captionText = meta.skipCaption ? '' : meta.cleanCaption
          const btnProps = {
            'type': 'button',
            'className': ['img-thumb-btn'],
            'role': 'tab',
            'aria-selected': idx === 0 ? 'true' : 'false',
            'data-stage-thumb': '',
            'data-index': String(idx),
            'data-caption': captionText,
            'aria-label': captionText
              ? `切换到第 ${idx + 1} 张：${captionText}`
              : `切换到第 ${idx + 1} 张图片`,
          }
          if (idx === 0) {
            btnProps['data-active'] = ''
          }

          return {
            type: 'element',
            tagName: 'button',
            properties: btnProps,
            children: [
              imgNode,
              {
                type: 'element',
                tagName: 'span',
                properties: {
                  'className': ['img-thumb-bar'],
                  'aria-hidden': 'true',
                },
                children: [],
              },
            ],
          }
        }),
      }

      node.children = [stageFrame, stageMeta, thumbRail, ...otherNodes]
    })

    // Pass 2: Process standalone paragraph images outside gallery containers
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'p' || typeof index !== 'number' || !parent) {
        return
      }
      if (processedGallerySet.has(parent) || hasClass(parent, 'img-grid-tile')) {
        return
      }

      const imgNodes = extractOnlyImagesFromParagraph(node)
      if (!imgNodes) {
        return
      }

      if (imgNodes.length === 1) {
        const figure = createSingleFigure(imgNodes[0])
        if (figure !== imgNodes[0]) {
          node.tagName = 'figure'
          node.properties = figure.properties
          node.children = figure.children
        }
        return
      }

      for (const imgNode of imgNodes) {
        parseImageMeta(imgNode)
      }
      parent.children.splice(index, 1, ...imgNodes)
    })
  }
}

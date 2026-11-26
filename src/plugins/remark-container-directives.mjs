import { visit } from 'unist-util-visit'

const admonitionTypes = {
  note: 'NOTE',
  tip: 'TIP',
  important: 'IMPORTANT',
  warning: 'WARNING',
  caution: 'CAUTION',
}

// Extract text from directive label
function getLabelText(node) {
  return node?.children
    ?.map(child => child.type === 'text' ? child.value : '')
    .join('')
    .trim() || ''
}

// Admonition Blocks
function createAdmonition(node, type, title) {
  const titleSpan = `<span class="admonition-title">${title}</span>`

  node.data ??= {}
  node.data.hName = 'blockquote'
  node.data.hProperties = {
    className: `admonition-${type}`,
  }

  node.children.unshift({
    type: 'html',
    value: titleSpan,
  })
}

// Collapsible Sections
function createFoldSection(node, title) {
  const summary = `<summary>${title}</summary>`

  node.data ??= {}
  node.data.hName = 'details'

  node.children.unshift({
    type: 'html',
    value: summary,
  })
}

// Gallery Containers (Rhythmic Focal Stage)
function createGallery(node, title) {
  node.data ??= {}
  node.data.hName = 'div'
  node.data.hProperties = {
    'className': ['gallery-container'],
    'data-gallery-mode': 'stage',
    ...(title ? { 'data-gallery-title': title } : {}),
  }
}

// Multi-Grid Containers (多宫格)
function createGrid(node, title, rawCols) {
  const colStr = String(rawCols ?? '').trim()
  const cols = colStr === '2' || colStr === '3' || colStr === '4' ? colStr : 'auto'

  node.data ??= {}
  node.data.hName = 'div'
  node.data.hProperties = {
    'className': ['gallery-container', 'img-grid-container'],
    'data-gallery-mode': 'grid',
    'data-grid-cols': cols,
    ...(title ? { 'data-gallery-title': title } : {}),
  }
}

export function remarkContainerDirectives() {
  const githubAdmonitionRegex = new RegExp(
    `^\\s*\\[!(${Object.values(admonitionTypes).join('|')})\\]\\s*`,
    'i',
  )

  return (tree) => {
    // Handle :::type[title] syntax
    visit(tree, 'containerDirective', (node) => {
      const type = node.name
      const labelNode = node.children?.[0]

      // Admonition Blocks
      if (admonitionTypes[type]) {
        // Optional [title] for admonitions
        let title = admonitionTypes[type]

        if (labelNode?.data?.directiveLabel) {
          const customTitle = getLabelText(labelNode)
          if (customTitle) {
            title = customTitle
          }
          node.children.shift()
        }

        createAdmonition(node, type, title)
        return
      }

      // Collapsible Sections
      if (type === 'fold') {
        // Require non-empty [title]
        const title = getLabelText(labelNode)
        if (!labelNode?.data?.directiveLabel || !title) {
          console.warn(`:::fold syntax requires [title] brackets with non-empty content`)
          return
        }

        node.children.shift()
        createFoldSection(node, title)
        return
      }

      // Gallery Containers (Stage by default, or Grid when {mode="grid"})
      if (type === 'gallery') {
        let title = ''
        if (labelNode?.data?.directiveLabel) {
          title = getLabelText(labelNode)
          node.children.shift()
        }

        const attrs = node.attributes ?? {}
        if (attrs.mode === 'grid') {
          createGrid(node, title, attrs.cols)
          return
        }

        createGallery(node, title)
        return
      }

      // Multi-Grid Containers (:::grid[title]{cols="2|3|4"})
      if (type === 'grid') {
        let title = ''
        if (labelNode?.data?.directiveLabel) {
          title = getLabelText(labelNode)
          node.children.shift()
        }

        const attrs = node.attributes ?? {}
        createGrid(node, title, attrs.cols)
      }
    })

    // Handle > [!TYPE] syntax
    visit(tree, 'blockquote', (node) => {
      const firstTextNode = node.children?.[0]?.children?.[0]
      if (firstTextNode?.type !== 'text') {
        return
      }

      const match = firstTextNode.value.match(githubAdmonitionRegex)
      if (!match) {
        return
      }

      const type = match[1].toLowerCase()
      const title = admonitionTypes[type]

      if (!title) {
        return
      }

      firstTextNode.value = firstTextNode.value.substring(match[0].length)

      createAdmonition(node, type, title)
    })
  }
}

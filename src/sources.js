import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { assertNonSensitivePath, fetchPublic, parseAllowedRoots, resolveAllowedPath } from './security.js'

export const DEFAULT_MAX_CHARS = 12_000
export const MAX_CHARS = 50_000
export const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
])

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function clampMaxChars(maxChars) {
  const value = Number(maxChars ?? DEFAULT_MAX_CHARS)
  return Math.max(256, Math.min(MAX_CHARS, Number.isFinite(value) ? value : DEFAULT_MAX_CHARS))
}

function decodeHtmlEntities(text) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase()
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10))
    return named[lower] ?? match
  })
}

export function htmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(article|blockquote|div|h[1-6]|li|main|p|pre|section|table|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractHtmlTitle(html, fallback) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  return match ? htmlToText(match[1]).slice(0, 240) : fallback
}

function excerpt(text, offset = 0, maxChars = DEFAULT_MAX_CHARS) {
  const start = Math.max(0, Number(offset) || 0)
  const size = clampMaxChars(maxChars)
  const content = text.slice(start, start + size)
  return {
    content,
    offset: start,
    nextOffset: start + content.length < text.length ? start + content.length : null,
    totalChars: text.length,
    truncated: start + content.length < text.length,
  }
}

async function responseBuffer(response) {
  if (!response.ok) throw new Error(`Source request failed with HTTP ${response.status}.`)
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_DOWNLOAD_BYTES) throw new Error('Source exceeds the 8 MiB download limit.')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('Source exceeds the 8 MiB download limit.')
  return buffer
}

function sourceRecord({ uri, title, mediaType, raw, text, offset, maxChars, extra = {} }) {
  const page = excerpt(text, offset, maxChars)
  return {
    uri,
    title,
    mediaType,
    retrievedAt: new Date().toISOString(),
    sha256: hash(raw),
    ...page,
    ...extra,
  }
}

export async function readWebSource(input, dependencies = {}) {
  const response = await fetchPublic(input.url, {
    fetchImpl: dependencies.fetchImpl,
    lookupFn: dependencies.lookupFn,
    allowedHosts: dependencies.allowedHosts,
    init: { headers: { accept: 'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1' } },
  })
  const raw = await responseBuffer(response)
  const mediaType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase()
  if (!(mediaType.startsWith('text/') || ['application/json', 'application/ld+json', 'application/xml', 'application/xhtml+xml'].includes(mediaType))) {
    throw new Error(`Unsupported textual source type: ${mediaType}. Use read_image_source for images.`)
  }

  const decoded = raw.toString('utf8')
  const isHtml = mediaType.includes('html') || /<html[\s>]/i.test(decoded)
  const finalUrl = response.url || input.url
  const fallbackTitle = new URL(finalUrl).hostname
  const text = isHtml ? htmlToText(decoded) : decoded.trim()
  return sourceRecord({
    uri: finalUrl,
    title: isHtml ? extractHtmlTitle(decoded, fallbackTitle) : fallbackTitle,
    mediaType,
    raw,
    text,
    offset: input.offset,
    maxChars: input.maxChars,
  })
}

export async function readLocalSource(input, { roots = parseAllowedRoots() } = {}) {
  const canonicalPath = await resolveAllowedPath(input.path, roots)
  const fileStats = await stat(canonicalPath)
  if (!fileStats.isFile()) throw new Error('The requested source is not a file.')
  if (fileStats.size > MAX_DOWNLOAD_BYTES) throw new Error('Source exceeds the 8 MiB read limit.')
  const raw = await readFile(canonicalPath)
  if (raw.includes(0)) throw new Error('Binary file detected. Use read_image_source for supported images.')

  return sourceRecord({
    uri: `file://${canonicalPath}`,
    title: path.basename(canonicalPath),
    mediaType: 'text/plain',
    raw,
    text: raw.toString('utf8'),
    offset: input.offset,
    maxChars: input.maxChars,
    extra: { path: canonicalPath, modifiedAt: fileStats.mtime.toISOString() },
  })
}

export async function readGithubSource(input, dependencies = {}) {
  const encodedPath = input.path.split('/').map(encodeURIComponent).join('/')
  const ref = input.ref || 'main'
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`
  const token = dependencies.githubToken ?? process.env.GITHUB_TOKEN
  const response = await fetchPublic(apiUrl, {
    fetchImpl: dependencies.fetchImpl,
    lookupFn: dependencies.lookupFn,
    allowedHosts: new Set(['api.github.com']),
    init: {
      headers: {
        accept: 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-github-api-version': '2022-11-28',
      },
    },
  })
  const rawResponse = await responseBuffer(response)
  const payload = JSON.parse(rawResponse.toString('utf8'))
  if (Array.isArray(payload) || payload.type !== 'file' || typeof payload.content !== 'string') {
    throw new Error('The requested GitHub source is not a file.')
  }
  const raw = Buffer.from(payload.content.replace(/\n/g, ''), payload.encoding || 'base64')
  if (raw.length > MAX_DOWNLOAD_BYTES) throw new Error('Source exceeds the 8 MiB read limit.')
  const uri = payload.html_url || `https://github.com/${input.owner}/${input.repo}/blob/${ref}/${input.path}`

  return sourceRecord({
    uri,
    title: `${input.owner}/${input.repo}/${input.path}`,
    mediaType: 'text/plain',
    raw,
    text: raw.toString('utf8'),
    offset: input.offset,
    maxChars: input.maxChars,
    extra: {
      repository: `${input.owner}/${input.repo}`,
      ref,
      gitSha: payload.sha,
    },
  })
}

function imageMimeType(filePath, declared = '') {
  const normalized = declared.split(';')[0].trim().toLowerCase()
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(normalized)) return normalized
  const extension = path.extname(filePath).toLowerCase()
  return {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }[extension]
}

export async function readImageSource(input, dependencies = {}) {
  let raw
  let uri
  let mediaType
  let title

  if (/^https?:\/\//i.test(input.source)) {
    const response = await fetchPublic(input.source, {
      fetchImpl: dependencies.fetchImpl,
      lookupFn: dependencies.lookupFn,
      allowedHosts: dependencies.allowedHosts,
      init: { headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' } },
    })
    raw = await responseBuffer(response)
    uri = response.url || input.source
    mediaType = imageMimeType(uri, response.headers.get('content-type') ?? '')
    title = new URL(uri).pathname.split('/').filter(Boolean).at(-1) || new URL(uri).hostname
  } else {
    const canonicalPath = await resolveAllowedPath(input.source, dependencies.roots ?? parseAllowedRoots())
    const fileStats = await stat(canonicalPath)
    if (!fileStats.isFile()) throw new Error('The requested image source is not a file.')
    if (fileStats.size > MAX_DOWNLOAD_BYTES) throw new Error('Image exceeds the 8 MiB read limit.')
    raw = await readFile(canonicalPath)
    uri = `file://${canonicalPath}`
    mediaType = imageMimeType(canonicalPath)
    title = path.basename(canonicalPath)
  }

  if (!mediaType) throw new Error('Only PNG, JPEG, GIF, and WebP image sources are supported.')
  return {
    uri,
    title,
    mediaType,
    retrievedAt: new Date().toISOString(),
    sha256: hash(raw),
    bytes: raw.length,
    data: raw.toString('base64'),
  }
}

async function walk(directory, results, maxFiles) {
  if (results.length >= maxFiles) return
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (results.length >= maxFiles) return
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) await walk(absolute, results, maxFiles)
    else if (entry.isFile()) {
      try {
        assertNonSensitivePath(absolute)
        results.push(absolute)
      } catch {
        // Credential-like files are never indexed as sources.
      }
    }
  }
}

export async function searchLocalSources(input, { roots = parseAllowedRoots() } = {}) {
  const root = await resolveAllowedPath(input.root || roots[0], roots)
  const rootStats = await stat(root)
  if (!rootStats.isDirectory()) throw new Error('Search root must be a directory.')

  const candidates = []
  await walk(root, candidates, Math.min(Math.max(input.maxFiles ?? 1_000, 1), 5_000))
  const needle = input.query.toLowerCase()
  const maxResults = Math.min(Math.max(input.maxResults ?? 20, 1), 100)
  const matches = []

  for (const candidate of candidates) {
    if (matches.length >= maxResults) break
    const relativePath = path.relative(root, candidate)
    if (relativePath.toLowerCase().includes(needle)) {
      matches.push({ path: candidate, relativePath, match: 'filename' })
      continue
    }
    const fileStats = await stat(candidate)
    if (fileStats.size > 512 * 1024) continue
    const raw = await readFile(candidate)
    if (raw.includes(0)) continue
    const text = raw.toString('utf8')
    const index = text.toLowerCase().indexOf(needle)
    if (index >= 0) {
      matches.push({
        path: candidate,
        relativePath,
        match: 'content',
        excerpt: text.slice(Math.max(0, index - 160), index + needle.length + 320).replace(/\s+/g, ' ').trim(),
      })
    }
  }

  return {
    root,
    query: input.query,
    scannedFiles: candidates.length,
    matches,
    truncated: matches.length >= maxResults,
  }
}

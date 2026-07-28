import { lookup } from 'node:dns/promises'
import { realpath } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
])

const SENSITIVE_BASENAMES = new Set([
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ed25519',
  'id_rsa',
  'known_hosts',
])

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }

  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true
  }
  if (normalized.startsWith('::ffff:')) {
    return isPrivateIpv4(normalized.slice('::ffff:'.length))
  }
  return false
}

export function isPrivateAddress(address) {
  const version = isIP(address)
  if (version === 4) return isPrivateIpv4(address)
  if (version === 6) return isPrivateIpv6(address)
  return true
}

export function parseAllowedHosts(value = process.env.SOURCE_ALLOWED_HOSTS ?? '') {
  return new Set(
    value
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  )
}

export async function validatePublicUrl(rawUrl, {
  allowedHosts = parseAllowedHosts(),
  lookupFn = lookup,
} = {}) {
  const url = new URL(rawUrl)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http:// and https:// sources are allowed.')
  }
  if (url.username || url.password) {
    throw new Error('Source URLs cannot contain credentials.')
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Local and private network sources are blocked.')
  }
  if (allowedHosts.size > 0 && !allowedHosts.has(hostname)) {
    throw new Error(`Host is not allowlisted: ${hostname}`)
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('Local and private network sources are blocked.')
  } else {
    const addresses = await lookupFn(hostname, { all: true, verbatim: true })
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error('The source hostname resolves to a private or invalid address.')
    }
  }

  return url
}

export async function fetchPublic(rawUrl, {
  fetchImpl = fetch,
  lookupFn = lookup,
  allowedHosts = parseAllowedHosts(),
  maxRedirects = 5,
  init = {},
} = {}) {
  let current = rawUrl

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const url = await validatePublicUrl(current, { allowedHosts, lookupFn })
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'manual',
      headers: {
        'user-agent': 'ComplexitySourceMCP/0.1 (+https://github.com/Complexity-ML)',
        ...(init.headers ?? {}),
      },
    })

    if (![301, 302, 303, 307, 308].includes(response.status)) return response

    const location = response.headers.get('location')
    if (!location) throw new Error('Source returned a redirect without a location.')
    current = new URL(location, url).toString()
  }

  throw new Error(`Source exceeded ${maxRedirects} redirects.`)
}

export function parseAllowedRoots(value = process.env.SOURCE_ROOTS ?? process.cwd()) {
  return value
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(root))
}

export function assertNonSensitivePath(candidate) {
  const basename = path.basename(candidate).toLowerCase()
  const extension = path.extname(basename)
  const envFile = basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example')
  if (
    envFile ||
    SENSITIVE_BASENAMES.has(basename) ||
    ['.key', '.p12', '.pfx', '.pem'].includes(extension)
  ) {
    throw new Error(`Sensitive credential file is not available as a source: ${basename}`)
  }
}

export async function resolveAllowedPath(requestedPath, roots = parseAllowedRoots()) {
  const candidate = await realpath(path.resolve(requestedPath))
  const canonicalRoots = await Promise.all(roots.map((root) => realpath(root)))
  const allowed = canonicalRoots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`))
  if (!allowed) throw new Error(`Path is outside the configured source roots: ${requestedPath}`)
  assertNonSensitivePath(candidate)
  return candidate
}

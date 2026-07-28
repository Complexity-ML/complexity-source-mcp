import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  readGithubSource,
  readImageSource,
  readLocalSource,
  readWebSource,
  searchLocalSources,
} from './sources.js'
import {
  fantasyCatalogStatus,
  getFantasyEntity,
  searchFantasyCatalog,
  traceFantasyRelations,
} from './fantasy-catalog.js'
import { parseAllowedHosts, parseAllowedRoots } from './security.js'

export const SERVER_NAME = 'complexity-source-mcp'
export const SERVER_VERSION = '0.1.0'

const paginationSchema = {
  offset: z.number().int().min(0).optional().describe('Character offset for continuing a truncated source.'),
  maxChars: z.number().int().min(256).max(50_000).optional().describe('Maximum source characters returned in this call.'),
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
}

function textualResult(source) {
  const continuation = source.nextOffset === null
    ? 'Complete source.'
    : `Truncated source. Continue at offset ${source.nextOffset}.`
  return {
    content: [{
      type: 'text',
      text: [
        `Source: ${source.title}`,
        `URI: ${source.uri}`,
        `Retrieved: ${source.retrievedAt}`,
        `SHA-256: ${source.sha256}`,
        continuation,
        '',
        source.content,
      ].join('\n'),
    }],
    structuredContent: { source },
  }
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    isError: true,
    content: [{ type: 'text', text: `Source read failed: ${message}` }],
  }
}

function structuredResult(name, value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: { [name]: value },
  }
}

export function createSourceServer(options = {}) {
  const roots = options.roots ?? parseAllowedRoots()
  const allowedHosts = options.allowedHosts ?? parseAllowedHosts()
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

  server.registerResource(
    'source-policy',
    'source://policy',
    {
      title: 'Complexity Source MCP policy',
      description: 'Read-only source access, provenance fields, limits, and configured roots.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          readOnly: true,
          roots,
          allowedWebHosts: [...allowedHosts],
          maxTextCharactersPerCall: 50_000,
          maxDownloadBytes: 8 * 1024 * 1024,
          privateNetworkAccess: false,
          sourceProvenance: ['uri', 'retrievedAt', 'sha256'],
        }, null, 2),
      }],
    }),
  )

  server.registerTool('read_web_source', {
    title: 'Read a public web source',
    description: 'Reads a public HTTP(S) page as text and returns its URL, retrieval time, SHA-256 fingerprint, and a bounded excerpt. Private network addresses are blocked.',
    inputSchema: {
      url: z.string().url(),
      ...paginationSchema,
    },
    annotations: { ...readOnlyAnnotations, openWorldHint: true },
  }, async (input) => {
    try {
      return textualResult(await readWebSource(input, { allowedHosts }))
    } catch (error) {
      return errorResult(error)
    }
  })

  server.registerTool('read_github_source', {
    title: 'Read a GitHub source file',
    description: 'Reads one file from a GitHub repository using the GitHub contents API. GITHUB_TOKEN is optional for public repositories and required for private ones.',
    inputSchema: {
      owner: z.string().min(1).max(100),
      repo: z.string().min(1).max(100),
      path: z.string().min(1).max(1_000),
      ref: z.string().min(1).max(240).optional(),
      ...paginationSchema,
    },
    annotations: { ...readOnlyAnnotations, openWorldHint: true },
  }, async (input) => {
    try {
      return textualResult(await readGithubSource(input))
    } catch (error) {
      return errorResult(error)
    }
  })

  server.registerTool('read_local_source', {
    title: 'Read an allowed local source',
    description: 'Reads one UTF-8 text file located inside SOURCE_ROOTS and returns canonical provenance. Symbolic-link escapes are rejected.',
    inputSchema: {
      path: z.string().min(1).max(4_000),
      ...paginationSchema,
    },
    annotations: { ...readOnlyAnnotations, openWorldHint: false },
  }, async (input) => {
    try {
      return textualResult(await readLocalSource(input, { roots }))
    } catch (error) {
      return errorResult(error)
    }
  })

  server.registerTool('search_local_sources', {
    title: 'Search allowed local sources',
    description: 'Searches filenames and bounded UTF-8 files inside SOURCE_ROOTS. Build outputs, dependency folders, and Git metadata are skipped.',
    inputSchema: {
      query: z.string().min(1).max(200),
      root: z.string().max(4_000).optional(),
      maxResults: z.number().int().min(1).max(100).optional(),
      maxFiles: z.number().int().min(1).max(5_000).optional(),
    },
    annotations: { ...readOnlyAnnotations, openWorldHint: false },
  }, async (input) => {
    try {
      const search = await searchLocalSources(input, { roots })
      return {
        content: [{ type: 'text', text: JSON.stringify(search, null, 2) }],
        structuredContent: { search },
      }
    } catch (error) {
      return errorResult(error)
    }
  })

  server.registerTool('read_image_source', {
    title: 'Read an image source',
    description: 'Returns a PNG, JPEG, GIF, or WebP image from an allowed local path or public URL, together with verifiable provenance. The connected AI must itself support image content to interpret it.',
    inputSchema: {
      source: z.string().min(1).max(4_000),
    },
    annotations: { ...readOnlyAnnotations, openWorldHint: true },
  }, async (input) => {
    try {
      const image = await readImageSource(input, { roots, allowedHosts })
      const { data, ...provenance } = image
      return {
        content: [
          { type: 'text', text: `Image source: ${image.title}\nURI: ${image.uri}\nRetrieved: ${image.retrievedAt}\nSHA-256: ${image.sha256}` },
          { type: 'image', data, mimeType: image.mediaType },
        ],
        structuredContent: { source: provenance },
      }
    } catch (error) {
      return errorResult(error)
    }
  })

  server.registerTool('list_source_policy', {
    title: 'List source policy',
    description: 'Lists the configured read-only roots, host allowlist, source limits, and provenance guarantees.',
    inputSchema: {},
    annotations: { ...readOnlyAnnotations, openWorldHint: false },
  }, async () => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        readOnly: true,
        roots,
        allowedWebHosts: [...allowedHosts],
        privateNetworkAccess: false,
        provenance: ['uri', 'retrievedAt', 'sha256'],
      }, null, 2),
    }],
  }))

  server.registerTool('search_fantasy_catalog', {
    title: 'Search the fantasy catalog',
    description: 'Searches canonical fantasy entity cards stored in the managed catalog. Results include facts, relations, and provenance and never modify the catalog.',
    inputSchema: {
      query: z.string().min(1).max(300),
      kinds: z.array(z.enum([
        'world',
        'location',
        'faction',
        'character',
        'creature',
        'artifact',
        'quest',
        'event',
      ])).max(8).optional(),
      maxResults: z.number().int().min(1).max(12).optional(),
    },
    annotations: { ...readOnlyAnnotations, openWorldHint: false },
  }, async (input) => {
    try {
      return structuredResult('search', await searchFantasyCatalog(input))
    } catch (error) {
      return errorResult(error)
    }
  })

  server.registerTool('get_fantasy_entity', {
    title: 'Read one fantasy entity card',
    description: 'Reads one canonical fantasy entity card and its directly related cards by stable key.',
    inputSchema: {
      key: z.string().min(1).max(160),
    },
    annotations: { ...readOnlyAnnotations, openWorldHint: false },
  }, async (input) => {
    try {
      return structuredResult('record', await getFantasyEntity(input))
    } catch (error) {
      return errorResult(error)
    }
  })

  server.registerTool('trace_fantasy_relations', {
    title: 'Trace fantasy relations',
    description: 'Traverses a bounded relation graph around one canonical fantasy entity card for multi-entity reasoning.',
    inputSchema: {
      key: z.string().min(1).max(160),
      maxDepth: z.number().int().min(1).max(3).optional(),
    },
    annotations: { ...readOnlyAnnotations, openWorldHint: false },
  }, async (input) => {
    try {
      return structuredResult('graph', await traceFantasyRelations(input))
    } catch (error) {
      return errorResult(error)
    }
  })

  server.registerTool('fantasy_catalog_status', {
    title: 'Check fantasy catalog status',
    description: 'Returns only aggregate readiness and entity counts for the managed fantasy catalog.',
    inputSchema: {},
    annotations: { ...readOnlyAnnotations, openWorldHint: false },
  }, async () => {
    try {
      return structuredResult('catalog', await fantasyCatalogStatus())
    } catch (error) {
      return errorResult(error)
    }
  })

  return server
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createSourceServer } from '../src/mcp-server.js'

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const server = createSourceServer({ roots: [process.cwd()], allowedHosts: new Set() })
const client = new Client({ name: 'complexity-source-smoke', version: '0.1.0' })

await Promise.all([
  server.connect(serverTransport),
  client.connect(clientTransport),
])

const tools = await client.listTools()
const policy = await client.callTool({ name: 'list_source_policy', arguments: {} })
const readme = await client.callTool({
  name: 'read_local_source',
  arguments: { path: new URL('../README.md', import.meta.url).pathname, maxChars: 512 },
})
if (tools.tools.length !== 10) throw new Error(`Expected 10 tools, received ${tools.tools.length}`)
if (policy.isError) throw new Error('Policy tool returned an error.')
if (readme.isError || !readme.structuredContent?.source?.sha256) {
  throw new Error('Local source provenance was not returned.')
}

console.log(`MCP smoke passed · ${tools.tools.length} read-only tools · local provenance returned`)
await client.close()
await server.close()

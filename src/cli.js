#!/usr/bin/env node

import { createServer } from 'node:http'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createSourceServer, SERVER_NAME, SERVER_VERSION } from './mcp-server.js'
import { parseAllowedRoots } from './security.js'

async function startStdio() {
  const server = createSourceServer()
  await server.connect(new StdioServerTransport())
  console.error(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio`)
}

async function startHttp() {
  const port = Number(process.env.PORT ?? 8790)
  const host = process.env.HOST ?? '127.0.0.1'
  const mcpPath = '/mcp'

  const httpServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        status: 'ready',
        readOnly: true,
        roots: parseAllowedRoots(),
        mcp: `http://${host}:${port}${mcpPath}`,
      }))
      return
    }

    if (url.pathname === mcpPath && request.method && ['POST', 'GET', 'DELETE'].includes(request.method)) {
      const server = createSourceServer()
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      response.on('close', () => {
        transport.close()
        server.close()
      })
      try {
        await server.connect(transport)
        await transport.handleRequest(request, response)
      } catch (error) {
        console.error('MCP request failed', error)
        if (!response.headersSent) response.writeHead(500).end('Internal server error')
      }
      return
    }

    response.writeHead(404).end('Not Found')
  })

  httpServer.listen(port, host, () => {
    console.error(`${SERVER_NAME} ${SERVER_VERSION}: http://${host}:${port}${mcpPath}`)
  })
}

if (process.argv.includes('--http')) await startHttp()
else await startStdio()

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { htmlToText, readLocalSource, readWebSource, searchLocalSources } from '../src/sources.js'

test('HTML is converted to readable text without scripts', () => {
  const text = htmlToText('<html><script>bad()</script><h1>Source &amp; proof</h1><p>First paragraph.</p></html>')
  assert.equal(text.includes('bad()'), false)
  assert.match(text, /Source & proof/)
  assert.match(text, /First paragraph/)
})

test('local sources include provenance and pagination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-mcp-'))
  const sourcePath = path.join(root, 'paper.txt')
  await writeFile(sourcePath, 'A'.repeat(400) + '\nverified evidence')
  const source = await readLocalSource({ path: sourcePath, maxChars: 256 }, { roots: [root] })
  assert.equal(source.uri, `file://${await realpath(sourcePath)}`)
  assert.equal(source.content.length, 256)
  assert.equal(source.nextOffset, 256)
  assert.equal(source.sha256.length, 64)
})

test('local source traversal outside roots is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-mcp-root-'))
  await assert.rejects(
    readLocalSource({ path: import.meta.filename }, { roots: [root] }),
    /outside the configured source roots/,
  )
})

test('local source search reports filename and content evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-mcp-search-'))
  await writeFile(path.join(root, 'architecture.md'), 'Shared dense path')
  await writeFile(path.join(root, 'notes.txt'), 'The routed expert is deterministic.')
  const result = await searchLocalSources({ query: 'routed', root }, { roots: [root] })
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].relativePath, 'notes.txt')
  assert.equal(result.matches[0].match, 'content')
})

test('web source returns the final text and source fingerprint', async () => {
  const fetchImpl = async () => new Response(
    '<html><title>Verified page</title><body><main>Grounded content</main></body></html>',
    {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  )
  const source = await readWebSource(
    { url: 'https://example.com/page' },
    {
      fetchImpl,
      lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
      allowedHosts: new Set(),
    },
  )
  assert.equal(source.title, 'Verified page')
  assert.match(source.content, /Grounded content/)
  assert.equal(source.sha256.length, 64)
})

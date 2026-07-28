import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { seedFantasyCatalog } from '../src/fantasy-catalog.js'

const seed = JSON.parse(
  await readFile(new URL('../data/fantasy-seed.json', import.meta.url), 'utf8'),
)

test('fantasy seed contains unique, connected entity cards', () => {
  const requiredKinds = new Set([
    'world',
    'location',
    'faction',
    'character',
    'creature',
    'artifact',
    'quest',
    'event',
  ])
  const keys = new Set(seed.map((entity) => entity.key))
  assert.equal(keys.size, seed.length)
  assert.ok(seed.length >= 30)
  for (const entity of seed) {
    requiredKinds.delete(entity.kind)
    assert.ok(entity.name)
    assert.ok(entity.summary)
    for (const relation of entity.relations ?? []) {
      assert.ok(keys.has(relation.targetKey), `${entity.key} points to missing ${relation.targetKey}`)
    }
  }
  assert.deepEqual([...requiredKinds], [])
})

test('fantasy seed is upserted through the private administration path', async () => {
  let operations = []
  const database = {
    collection() {
      return {
        async bulkWrite(nextOperations) {
          operations = nextOperations
          return { upsertedCount: nextOperations.length, modifiedCount: 0 }
        },
      }
    },
  }
  const result = await seedFantasyCatalog(seed, { database })
  assert.equal(result.entities, seed.length)
  assert.equal(operations.length, seed.length)
  assert.ok(operations.every((operation) => operation.updateOne?.upsert === true))
})

import { MongoClient } from 'mongodb'

const DEFAULT_DATABASE = 'complexity_fantasy'
const COLLECTION = 'fantasy_entities'
const MAX_RESULTS = 12

const clients = new Map()
const initializedDatabases = new Set()

function settings() {
  return {
    uri: process.env.MONGODB_URI?.trim(),
    databaseName: process.env.MONGODB_DATABASE?.trim() || DEFAULT_DATABASE,
  }
}

async function databaseConnection() {
  const { uri, databaseName } = settings()
  if (!uri) return null

  const cacheKey = `${uri}\u0000${databaseName}`
  let clientPromise = clients.get(cacheKey)
  if (!clientPromise) {
    clientPromise = new MongoClient(uri, {
      maxPoolSize: 6,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 8_000,
    }).connect()
    clients.set(cacheKey, clientPromise)
  }

  const client = await clientPromise
  const database = client.db(databaseName)
  if (!initializedDatabases.has(cacheKey)) {
    const collection = database.collection(COLLECTION)
    await Promise.all([
      collection.createIndex({ key: 1 }, { unique: true }),
      collection.createIndex({ datasetId: 1, kind: 1 }),
      collection.createIndex({ 'relations.targetKey': 1 }),
      collection.createIndex(
        {
          name: 'text',
          aliases: 'text',
          summary: 'text',
          description: 'text',
          facts: 'text',
          tags: 'text',
        },
        {
          name: 'fantasy_text',
          weights: {
            name: 12,
            aliases: 8,
            summary: 6,
            tags: 5,
            facts: 3,
            description: 1,
          },
          default_language: 'none',
        },
      ),
    ])
    initializedDatabases.add(cacheKey)
  }
  return database
}

function publicEntity(entity, { includeDescription = true } = {}) {
  return {
    key: entity.key,
    kind: entity.kind,
    name: entity.name,
    aliases: entity.aliases ?? [],
    summary: entity.summary,
    ...(includeDescription ? { description: entity.description } : {}),
    facts: entity.facts ?? [],
    tags: entity.tags ?? [],
    attributes: entity.attributes ?? {},
    relations: entity.relations ?? [],
    provenance: {
      datasetId: entity.datasetId,
      source: entity.source,
      version: entity.version,
      updatedAt: entity.updatedAt,
    },
  }
}

export async function seedFantasyCatalog(entities, dependencies = {}) {
  const database = dependencies.database ?? await databaseConnection()
  if (!database) throw new Error('MONGODB_URI is required to seed the fantasy catalog.')
  if (!Array.isArray(entities) || entities.length === 0) {
    throw new Error('The fantasy seed must contain at least one entity.')
  }

  const now = new Date()
  const collection = database.collection(COLLECTION)
  const keys = new Set()
  for (const entity of entities) {
    if (!entity?.key || !entity?.kind || !entity?.name || !entity?.summary) {
      throw new Error('Each fantasy entity requires key, kind, name, and summary.')
    }
    if (keys.has(entity.key)) throw new Error(`Duplicate fantasy entity key: ${entity.key}`)
    keys.add(entity.key)
  }

  const operations = entities.map((entity) => ({
    updateOne: {
      filter: { key: entity.key },
      update: {
        $set: {
          ...entity,
          datasetId: entity.datasetId ?? 'aethoria-v1',
          aliases: entity.aliases ?? [],
          description: entity.description ?? entity.summary,
          facts: entity.facts ?? [],
          tags: entity.tags ?? [],
          attributes: entity.attributes ?? {},
          relations: entity.relations ?? [],
          source: entity.source ?? 'Complexity original fantasy seed',
          version: entity.version ?? '1.0.0',
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsert: true,
    },
  }))

  const result = await collection.bulkWrite(operations, { ordered: true })
  return {
    configured: true,
    entities: entities.length,
    inserted: result.upsertedCount,
    updated: result.modifiedCount,
    database: settings().databaseName,
    collection: COLLECTION,
  }
}

export async function searchFantasyCatalog(input, dependencies = {}) {
  const database = dependencies.database ?? await databaseConnection()
  if (!database) return { configured: false, query: input.query, matches: [] }

  const query = String(input.query ?? '').trim()
  if (!query) throw new Error('Fantasy catalog search requires a query.')
  const maxResults = Math.max(1, Math.min(MAX_RESULTS, Number(input.maxResults) || 5))
  const kinds = (input.kinds ?? []).map(String).filter(Boolean)
  const filter = {
    $text: { $search: query },
    ...(kinds.length ? { kind: { $in: kinds } } : {}),
  }

  let rows = await database.collection(COLLECTION)
    .find(filter, {
      projection: {
        score: { $meta: 'textScore' },
        key: 1,
        kind: 1,
        name: 1,
        aliases: 1,
        summary: 1,
        description: 1,
        facts: 1,
        tags: 1,
        attributes: 1,
        relations: 1,
        datasetId: 1,
        source: 1,
        version: 1,
        updatedAt: 1,
      },
    })
    .sort({ score: { $meta: 'textScore' } })
    .limit(maxResults)
    .toArray()

  if (rows.length === 0) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    rows = await database.collection(COLLECTION)
      .find({
        ...(kinds.length ? { kind: { $in: kinds } } : {}),
        $or: [
          { name: { $regex: escaped, $options: 'i' } },
          { aliases: { $regex: escaped, $options: 'i' } },
          { tags: { $regex: escaped, $options: 'i' } },
        ],
      })
      .limit(maxResults)
      .toArray()
  }

  return {
    configured: true,
    query,
    matches: rows.map((row) => ({
      ...publicEntity(row),
      score: row.score ?? null,
    })),
  }
}

export async function getFantasyEntity(input, dependencies = {}) {
  const database = dependencies.database ?? await databaseConnection()
  if (!database) return { configured: false, entity: null, related: [] }

  const entity = await database.collection(COLLECTION).findOne({ key: input.key })
  if (!entity) throw new Error('Fantasy catalog entity was not found.')

  const targetKeys = [...new Set((entity.relations ?? []).map((relation) => relation.targetKey))]
  const related = targetKeys.length
    ? await database.collection(COLLECTION).find({ key: { $in: targetKeys } }).limit(20).toArray()
    : []

  return {
    configured: true,
    entity: publicEntity(entity),
    related: related.map((item) => publicEntity(item, { includeDescription: false })),
  }
}

export async function traceFantasyRelations(input, dependencies = {}) {
  const database = dependencies.database ?? await databaseConnection()
  if (!database) return { configured: false, root: null, nodes: [], edges: [] }

  const maxDepth = Math.max(1, Math.min(3, Number(input.maxDepth) || 2))
  const collection = database.collection(COLLECTION)
  const root = await collection.findOne({ key: input.key })
  if (!root) throw new Error('Fantasy catalog entity was not found.')

  const nodes = new Map([[root.key, root]])
  const edges = []
  let frontier = [root]
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const targetKeys = []
    for (const entity of frontier) {
      for (const relation of entity.relations ?? []) {
        edges.push({
          from: entity.key,
          to: relation.targetKey,
          type: relation.type,
          detail: relation.detail ?? null,
        })
        if (!nodes.has(relation.targetKey)) targetKeys.push(relation.targetKey)
      }
    }
    if (targetKeys.length === 0) break
    frontier = await collection.find({ key: { $in: [...new Set(targetKeys)] } }).limit(60).toArray()
    for (const entity of frontier) nodes.set(entity.key, entity)
  }

  return {
    configured: true,
    root: root.key,
    nodes: [...nodes.values()].map((entity) => publicEntity(entity, { includeDescription: false })),
    edges,
  }
}

export async function fantasyCatalogStatus(dependencies = {}) {
  const database = dependencies.database ?? await databaseConnection()
  if (!database) {
    return {
      configured: false,
      database: settings().databaseName,
      collection: COLLECTION,
      entities: 0,
      kinds: {},
    }
  }

  const collection = database.collection(COLLECTION)
  const [entities, kindRows] = await Promise.all([
    collection.estimatedDocumentCount(),
    collection.aggregate([
      { $group: { _id: '$kind', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
  ])
  return {
    configured: true,
    database: settings().databaseName,
    collection: COLLECTION,
    entities,
    kinds: Object.fromEntries(kindRows.map((row) => [row._id, row.count])),
  }
}

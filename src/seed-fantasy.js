#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { seedFantasyCatalog } from './fantasy-catalog.js'

const seedUrl = new URL('../data/fantasy-seed.json', import.meta.url)
const entities = JSON.parse(await readFile(seedUrl, 'utf8'))
const result = await seedFantasyCatalog(entities)

console.log(
  `Fantasy catalog seeded · ${result.entities} entities · ${result.inserted} inserted · ${result.updated} updated`,
)

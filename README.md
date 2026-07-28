---
title: Complexity Source MCP
emoji: 📚
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
short_description: Read-only sources and fantasy entity cards for AI systems.
---

# Complexity Source MCP

Read-only Model Context Protocol server that gives an AI access to verifiable
sources and a managed fantasy knowledge catalog instead of asking it to fill
missing facts from memory.

The server is built with the official
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
and exposes ten tools:

- `read_web_source` — public HTML, JSON, XML, and text sources;
- `read_github_source` — one GitHub repository file at an explicit ref;
- `read_local_source` — one UTF-8 file inside an allowed root;
- `search_local_sources` — bounded filename and content search;
- `read_image_source` — PNG, JPEG, GIF, or WebP for vision-capable clients;
- `list_source_policy` — active roots, limits, and provenance policy.
- `search_fantasy_catalog` — search canonical fantasy entity cards;
- `get_fantasy_entity` — read one card and its direct relations;
- `trace_fantasy_relations` — traverse a bounded entity relation graph;
- `fantasy_catalog_status` — aggregate catalog readiness and counts.

Every retrieved source carries its canonical URI, retrieval timestamp, and
SHA-256 fingerprint. Text is paginated instead of silently discarded.

## Fantasy catalog

The included Aethoria seed is an original, internally consistent fantasy
dataset. It contains structured cards for worlds, locations, factions,
characters, creatures, artifacts, quests, and events. Relations between cards
let an agent answer questions that require several facts without inventing
missing lore.

MongoDB is the storage layer. Configure an administrative environment and seed
the catalog once:

```bash
cp .env.example .env
# Set MONGODB_URI in .env.
npm run seed:fantasy
```

The Docker image seeds these cards idempotently at startup when `MONGODB_URI`
is configured. The HTTP/MCP surface exposes only read-only catalog tools.
There is deliberately no public ingestion tool: visitors cannot add or modify
cards.

## Security boundary

- All MCP tools are annotated read-only.
- Local paths are restricted to `SOURCE_ROOTS`; symbolic-link escapes fail.
- Loopback, link-local, private network, and cloud metadata URLs are blocked.
- `SOURCE_ALLOWED_HOSTS` can restrict web access to an explicit hostname list.
- Credential-like files (`.env`, private keys, package credentials) are refused.
- Downloads are limited to 8 MiB and text calls to 50,000 characters.
- No tool can create, edit, move, or delete content.
- MongoDB credentials stay server-side and are never returned by MCP tools.

This server provides source material. It does not guarantee that the connected
model will interpret the material correctly, so the UI should retain and show
the returned provenance beside generated answers.

## Install and run

```bash
git clone https://github.com/Complexity-ML/complexity-source-mcp.git
cd complexity-source-mcp
npm install

SOURCE_ROOTS=/absolute/path/to/your/sources npm start
```

`npm start` uses MCP over stdio, which is the normal transport for a local AI
client. An optional loopback HTTP transport is available for local development:

```bash
SOURCE_ROOTS=/Users/boris/Dev npm run start:http
```

It listens on `http://127.0.0.1:8790/mcp`. Set `PORT` or `HOST` to override the
listener.

## Hugging Face Space

The repository is directly deployable as a Hugging Face Docker Space. The
container listens on port `7860` and exposes:

- `GET /` — readiness and server metadata;
- `POST /mcp` — MCP Streamable HTTP requests.

The hosted container deliberately restricts local-file tools to the empty
`public-sources` directory. Web and GitHub source tools remain available, and
private-network URLs remain blocked.

After deployment, configure AI LAB with:

```bash
SOURCE_MCP_URL=https://YOUR-SPACE.hf.space/mcp
```

Free Spaces can sleep while idle. AI LAB therefore treats source grounding as
an optional service and reports its live connection state in the Agent panel.
Configure `MONGODB_URI` as a Space secret and `MONGODB_DATABASE` as a variable
before seeding. If the Space is private, also configure `SOURCE_MCP_TOKEN` as a
secret in the website deployment; AI LAB sends it as a Bearer token.

## MCP client configuration

```json
{
  "mcpServers": {
    "complexity-sources": {
      "command": "node",
      "args": [
        "/absolute/path/to/complexity-source-mcp/src/cli.js"
      ],
      "env": {
        "SOURCE_ROOTS": "/absolute/path/to/your/sources"
      }
    }
  }
}
```

Multiple source roots use the operating-system path separator (`:` on macOS and
Linux). For example:

```bash
SOURCE_ROOTS="/path/to/papers:/path/to/code"
```

Optional environment variables:

- `GITHUB_TOKEN` — read private GitHub sources using the token's own scopes;
- `SOURCE_ALLOWED_HOSTS` — comma-separated web host allowlist;
- `PORT` and `HOST` — HTTP development transport only.
- `MONGODB_URI` — server-side MongoDB connection string;
- `MONGODB_DATABASE` — catalog database name (defaults to
  `complexity_fantasy`).

Never commit a GitHub token. Prefer a fine-grained, read-only token limited to
the repositories the AI is allowed to inspect.

## Verify

```bash
npm test
npm run smoke
```

The smoke test connects an official MCP client to the server through the
official in-memory transport, lists the tools, and calls the policy tool.

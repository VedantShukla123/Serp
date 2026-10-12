// Run with `npm test`.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import { INTEGRATIONS } from './sdkCatalog.ts'

const repo = (p: string) => new URL(`../../${p}`, import.meta.url)
const group = (id: string) => INTEGRATIONS.find((i) => i.id === id)!.group

test('availability labels follow what exists in the repository', () => {
  // MCP server: runnable stdio entry point + protocol tests exist -> available now
  assert.ok(existsSync(repo('run_mcp.py')) && existsSync(repo('tests/test_mcp_server.py')))
  assert.match(readFileSync(repo('run_mcp.py'), 'utf-8'), /server\.run\("stdio"\)/)
  assert.equal(group('mcp'), 'now')
  assert.match(INTEGRATIONS.find((i) => i.id === 'mcp')!.today, /connected only after you add the config/)
  // Python client: package exists, but nothing is published -> local, labelled as such
  assert.ok(existsSync(repo('proofgate_client/__init__.py')) && existsSync(repo('tests/test_python_client.py')))
  assert.ok(!existsSync(repo('pyproject.toml')) && !existsSync(repo('setup.py')))
  assert.equal(group('pyclient'), 'local')
  assert.equal(INTEGRATIONS.find((i) => i.id === 'pyclient')!.title, 'Python client — available locally, not published')
  assert.equal(group('pypi'), 'soon')
  // CLI really exists
  assert.match(readFileSync(repo('run.py'), 'utf-8'), /--serve/)
  assert.equal(group('cli'), 'local')
  // no TypeScript SDK anywhere in the repo
  assert.ok(!existsSync(repo('sdk')) && !existsSync(repo('frontend/src/sdk')))
  assert.equal(group('ts'), 'soon')
  // unbuilt capabilities stay unavailable
  for (const id of ['providers', 'auth', 'mcphttp']) assert.equal(group(id), 'none')
})

test('every available integration has a way to start; examples match the shell', () => {
  for (const i of INTEGRATIONS.filter((x) => x.group === 'now' || x.group === 'local')) assert.ok(i.code || i.steps, i.id)
  const rest = INTEGRATIONS.find((i) => i.id === 'rest')!.code!
  assert.match(rest('powershell').code, /^\$res = Invoke-RestMethod "http:\/\/localhost:8000\/health"/)
  assert.equal(rest('bash').code, "curl -s 'http://localhost:8000/health'")
  assert.match(INTEGRATIONS.find((i) => i.id === 'mcp')!.code!('powershell').code, /run_mcp\.py --check$/)
  const client = INTEGRATIONS.find((i) => i.id === 'pyclient')!.code!('bash').code
  for (const m of ['health()', 'list_runs(limit=1)', 'get_run(runs[0]["run_id"])']) assert.ok(client.includes(m), m)
  const src = readFileSync(repo('proofgate_client/client.py'), 'utf-8')
  for (const fn of ['def health', 'def list_runs', 'def get_run', 'def get_evidence', 'def find_and_verify', 'def verify']) assert.ok(src.includes(fn), fn)
})

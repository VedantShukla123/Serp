// Run with `npm test`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { MCP_TOOLS, mcpCmd, mcpConfig } from './mcpSetup.ts'

const SERVER_PY = readFileSync(new URL('../../app/mcp/server.py', import.meta.url), 'utf-8')

test('documented tools are exactly the tools the server registers', () => {
  const registered = [...SERVER_PY.matchAll(/@mcp_server\.tool\(\s*name="(\w+)"/g)].map((m) => m[1]).sort()
  assert.deepEqual(registered, ['find_and_verify', 'get_evidence', 'get_run', 'verify_candidate'])
  assert.deepEqual(MCP_TOOLS.map((t) => t.n).sort(), registered)
  assert.deepEqual(MCP_TOOLS.filter((t) => t.cost === 'paid').map((t) => t.n).sort(), ['find_and_verify', 'verify_candidate'])
})

test('host config is valid JSON for both shells, launches run_mcp.py with the venv python, holds no secrets', () => {
  const win = JSON.parse(mcpConfig('powershell')).mcpServers.proofgate
  assert.equal(win.command, String.raw`C:\ABSOLUTE\PATH\TO\serpapi-hackthon\.venv\Scripts\python.exe`)
  assert.deepEqual(win.args, [String.raw`C:\ABSOLUTE\PATH\TO\serpapi-hackthon\run_mcp.py`])
  const nix = JSON.parse(mcpConfig('bash')).mcpServers.proofgate
  assert.equal(nix.command, '/ABSOLUTE/PATH/TO/serpapi-hackthon/.venv/bin/python')
  assert.deepEqual(nix.args, ['/ABSOLUTE/PATH/TO/serpapi-hackthon/run_mcp.py'])
  for (const cfg of [win, nix]) assert.equal(cfg.env, undefined)
  assert.doesNotMatch(mcpConfig('powershell') + mcpConfig('bash'), /KEY|TOKEN|SECRET/i)
})

test('setup commands match the repository', () => {
  assert.equal(mcpCmd('install', 'powershell'), String.raw`.\.venv\Scripts\python.exe -m pip install -r requirements.txt`)
  assert.equal(mcpCmd('check', 'powershell'), String.raw`.\.venv\Scripts\python.exe run_mcp.py --check`)
  assert.equal(mcpCmd('check', 'bash'), '.venv/bin/python run_mcp.py --check')
  assert.match(mcpCmd('env', 'powershell'), /^Copy-Item \.env\.example \.env/)
  const runMcp = readFileSync(new URL('../../run_mcp.py', import.meta.url), 'utf-8')
  assert.match(runMcp, /"--check" in sys\.argv/)
  assert.match(readFileSync(new URL('../../requirements.txt', import.meta.url), 'utf-8'), /^mcp>=2\.3,<3/m)
})

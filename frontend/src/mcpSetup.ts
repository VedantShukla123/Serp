/* MCP setup facts for the Developer Hub (no React) — unit-tested.
   Must match run_mcp.py and the tools registered in app/mcp/server.py. */
import type { Shell } from './devhub.ts'

/* Facts below match run_mcp.py, app/mcp/server.py and tests/test_mcp_server.py. */
export const MCP_TOOLS = [
  { n: 'find_and_verify', cost: 'paid' as const, args: 'request, action?, max_candidates? (1–50), engine?', d: 'Live search + Jev verification. Returns run_id, decision and each candidate’s status.' },
  { n: 'verify_candidate', cost: 'paid' as const, args: 'requirements[], candidate', d: 'Jev verdicts for one candidate you supply. No search.' },
  { n: 'get_run', cost: 'free' as const, args: 'run_id', d: 'A stored run: requirements, ranking, verdicts, decision. Read-only.' },
  { n: 'get_evidence', cost: 'free' as const, args: 'run_id, include_raw_serpapi?', d: 'Stored candidates and Jev attempts (raw SerpApi on request). Read-only.' },
]

export const PLACEHOLDER_WIN = 'C:\\\\ABSOLUTE\\\\PATH\\\\TO\\\\serpapi-hackthon'
export const PLACEHOLDER_NIX = '/ABSOLUTE/PATH/TO/serpapi-hackthon'

export function mcpConfig(shell: Shell): string {
  const win = shell === 'powershell'
  const root = win ? PLACEHOLDER_WIN : PLACEHOLDER_NIX
  const py = win ? `${root}\\\\.venv\\\\Scripts\\\\python.exe` : `${root}/.venv/bin/python`
  const script = win ? `${root}\\\\run_mcp.py` : `${root}/run_mcp.py`
  return `{
  "mcpServers": {
    "proofgate": {
      "command": "${py}",
      "args": ["${script}"]
    }
  }
}`
}

export function mcpCmd(step: 'install' | 'env' | 'check' | 'path', shell: Shell): string {
  const py = shell === 'powershell' ? '.\\.venv\\Scripts\\python.exe' : '.venv/bin/python'
  switch (step) {
    case 'install': return `${py} -m pip install -r requirements.txt`
    case 'env': return shell === 'powershell' ? 'Copy-Item .env.example .env   # then edit .env and add your keys' : 'cp .env.example .env   # then edit .env and add your keys'
    case 'check': return `${py} run_mcp.py --check`
    case 'path': return shell === 'powershell' ? '(Resolve-Path .).Path' : 'pwd'
  }
}

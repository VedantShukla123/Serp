/* SDKs & integrations — what exists in this repository and how to start (no React; unit-tested).
   Facts: run.py, run_mcp.py (+ tests/test_mcp_server.py), proofgate_client/, app/mcp/adapter.py,
   app/api/routes.py. Nothing here is published to a package registry. */
import { API_BASE, example, type Shell } from './devhub.ts'
import { mcpCmd } from './mcpSetup.ts'

export type Group = 'now' | 'local' | 'demo' | 'soon' | 'none'
export type Integration = {
  id: string
  group: Group
  title: string
  what: string             // what it is
  today: string            // what you can do with it today
  steps?: string[]         // minimum steps to start
  code?: (shell: Shell) => { lang: string; code: string }
  link?: { label: string; to: string }
  note?: string
}

export const GROUP_INFO: Record<Group, { title: string; blurb: string }> = {
  now: { title: 'Available now', blurb: 'Works today against your local ProofGate.' },
  local: { title: 'Local / in-process only', blurb: 'Works today from a copy of this repository; not published anywhere.' },
  demo: { title: 'Demo only', blurb: 'Simulated — nothing real is booked, bought or charged.' },
  soon: { title: 'Coming soon', blurb: 'Planned; not in this repository yet.' },
  none: { title: 'Not available', blurb: 'Not built and not part of this demo.' },
}

const py = (shell: Shell) => (shell === 'powershell' ? '.\\.venv\\Scripts\\python.exe' : '.venv/bin/python')

export const INTEGRATIONS: Integration[] = [
  {
    id: 'rest', group: 'now', title: 'REST API',
    what: 'JSON over HTTP on http://localhost:8000.',
    today: 'Verify requests, read stored runs and evidence, run the action simulator.',
    steps: ['Start the API: python run.py --serve', 'Check it with GET /health (free).'],
    code: (shell) => ({ lang: shell === 'bash' ? 'bash' : 'PowerShell', code: example({ method: 'GET', path: '/health' }, shell) }),
    link: { label: 'All endpoints', to: '/app/developers/api' },
  },
  {
    id: 'sse', group: 'now', title: 'Live trace (Server-Sent Events)',
    what: 'A stream of pipeline events: requirements, search, ranking, each Jev verdict, final decision.',
    today: 'Show progress live in your own UI — the Playground uses it.',
    code: (shell) => ({ lang: shell === 'bash' ? 'bash' : 'PowerShell', code: example({ method: 'GET', path: '/v1/agent/chat/stream?message=Hotel%20in%20Goa', stream: true }, shell) }),
    note: 'Streaming a chat turn uses API credits (LLM, and SerpApi + Jev when it searches).',
    link: { label: 'Event list', to: '/app/developers/api/get-v1-agent-chat-stream' },
  },
  {
    id: 'mcp', group: 'now', title: 'MCP server (stdio)',
    what: 'Lets MCP-compatible AI apps call find_and_verify, verify_candidate, get_run and get_evidence.',
    today: 'Server implemented and protocol-tested. Your AI app is connected only after you add the config.',
    steps: ['Install requirements.txt (includes the mcp SDK).', 'Check the server with the command below.', 'Add the host configuration from the MCP tab and restart the host.'],
    code: (shell) => ({ lang: shell === 'bash' ? 'bash' : 'PowerShell', code: mcpCmd('check', shell) }),
    link: { label: 'MCP setup guide', to: '/app/developers/mcp' },
  },
  {
    id: 'pyclient', group: 'local', title: 'Python client — available locally, not published',
    what: 'proofgate_client: a small typed wrapper around the REST API (httpx), with clear exceptions.',
    today: 'health(), list_runs(), get_run(), get_evidence() free; find_and_verify() and verify() use credits.',
    steps: ['Start the API (python run.py --serve).', 'Run Python from the repository root, or add it to PYTHONPATH.'],
    code: () => ({ lang: 'python', code: `from getpass import getpass
from proofgate_client import ProofGateClient, ProofGateNotFound

with ProofGateClient("${API_BASE}") as pg:
    if pg.auth_status()["auth_required"]:  # deployed demo: shared demo password -> short-lived token
        pg.login(getpass("Demo password: "))
    print(pg.health()["ready"])
    runs = pg.list_runs(limit=1)          # free; empty on a fresh server
    if runs:
        run = pg.get_run(runs[0]["run_id"])   # ProofGateNotFound if unknown
        print(run["status"], len(run["attempts"]), "candidates checked")` }),
    note: 'Not on PyPI — there is no pip install for it yet. See proofgate_client/README.md.',
  },
  {
    id: 'adapter', group: 'local', title: 'Python adapter (no server)',
    what: 'app.mcp.adapter — the same four functions the MCP server exposes, called in-process.',
    today: 'Script against the pipeline and the run store without running the API.',
    code: () => ({ lang: 'python', code: `from app.mcp import adapter   # run from the repository root

run = adapter.get_run("PASTE_RUN_ID")       # free; KeyError if unknown
print(run["status"])` }),
  },
  {
    id: 'cli', group: 'local', title: 'CLI — run.py',
    what: 'A terminal command that runs one verification and prints the ranking, verdicts and run_id.',
    today: 'Quick checks without the UI. Each verification uses API credits.',
    code: (shell) => ({ lang: shell === 'bash' ? 'bash' : 'PowerShell', code: `${py(shell)} run.py --action book_hotel "Hotel in Goa, beachfront"` }),
  },
  {
    id: 'sim', group: 'demo', title: 'Action simulator',
    what: 'Simulated hotel bookings (POST /v1/bookings) and product orders (POST /v1/orders).',
    today: 'Demonstrate the human-review step: REJECTED is blocked, UNVERIFIED needs acknowledgement.',
    link: { label: 'Booking & order endpoints', to: '/app/developers/api/get-v1-runs-run-id-candidates-candidate-id-action-context' },
  },
  { id: 'ts', group: 'soon', title: 'TypeScript SDK', what: 'A typed client for Node and browsers.', today: 'Meanwhile, call the REST API with fetch.' },
  { id: 'pypi', group: 'soon', title: 'Published Python package', what: 'proofgate_client on PyPI.', today: 'Meanwhile, use the local client from this repository.' },
  { id: 'providers', group: 'none', title: 'Real booking providers & payments', what: 'Reserving rooms, placing orders, charging cards.', today: 'Out of scope — only simulated SIM- records exist.' },
  { id: 'auth', group: 'none', title: 'API authentication', what: 'API keys or tokens for the REST API.', today: 'The local server accepts every request; keep it on your machine.' },
  { id: 'mcphttp', group: 'none', title: 'MCP over HTTP', what: 'A network transport for remote MCP clients.', today: 'stdio only, so nothing is exposed on the network.' },
]

export const GROUP_ORDER: Group[] = ['now', 'local', 'demo', 'soon', 'none']

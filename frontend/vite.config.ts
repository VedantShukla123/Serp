import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Dev only: same-origin API calls are proxied to the local backend. Production builds use
  // VITE_API_BASE_URL (see DEPLOYMENT.md) or serve the API from the same origin.
  server: { port: 5173, proxy: { '/v1': 'http://localhost:8000', '/health': 'http://localhost:8000' } },
})

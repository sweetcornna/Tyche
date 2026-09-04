import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    target: 'es2022'
  },
  server: {
    host: '127.0.0.1',
    port: 5173
  }
})

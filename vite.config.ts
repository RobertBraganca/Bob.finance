import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // Bibliotecas em pacotes próprios (revisão de 07/10/2026): mudam
        // pouco, então o navegador as mantém em cache entre publicações em
        // vez de baixar de novo ~200 kB a cada deploy do app.
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'vendor-router', test: /node_modules[\\/](react-router|react-router-dom)[\\/]/, priority: 25 },
            { name: 'vendor-supabase', test: /node_modules[\\/]@supabase[\\/]/, priority: 20 },
            { name: 'vendor-query', test: /node_modules[\\/]@tanstack[\\/]/, priority: 20 },
            { name: 'vendor-ui', test: /node_modules[\\/](@base-ui|@base-ui-components|@floating-ui)[\\/]/, priority: 15 },
          ],
        },
      },
    },
  },
  server: {
    // PORT lets a preview harness reassign this when 5173 is already taken
    // by another session's copy of this same dev server.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
    },
  },
})

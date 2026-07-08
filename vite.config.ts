import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Sibling of empower-peer-to-peer: Vite 7 + React + vite-plugin-pwa (injectManifest,
// hand-written SW). Offline-first bundling of the looping video + soundtrack.
export default defineConfig({
  base: "/",
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/service-worker",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: false,
      injectManifest: {
        globPatterns: [
          "**/*.{js,css,html,webmanifest}",
          "static/**/*.{svg,png,jpg,jpeg,gif,webp,ttf,woff2,mp3,m4a,mp4,ico}",
        ],
        // screen.mp4 can be a few MB; keep the precache ceiling generous.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
      },
      manifest: {
        name: "Empower — A/V Sync (spike)",
        short_name: "AV Sync",
        description:
          "Fixed-screen video leader keeps followers’ audio in sync over WebRTC.",
        display: "standalone",
        orientation: "portrait",
        background_color: "#111111",
        theme_color: "#111111",
        start_url: "/",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
    }),
  ],
  server: {
    port: 3100,
    strictPort: true,
    host: true,
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      ".trycloudflare.com",
      "bs-local.com",
    ],
  },
  preview: { port: 4273, strictPort: true, host: true, allowedHosts: true },
  build: {
    assetsDir: "static",
    rollupOptions: {
      output: {
        assetFileNames: "static/[name].[hash][extname]",
        entryFileNames: "static/js/[name].[hash].js",
        chunkFileNames: "static/js/[name].[hash].js",
      },
    },
  },
})

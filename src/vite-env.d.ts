/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Ensure .m4a imports resolve to a URL string even if not in vite/client's default list.
declare module '*.m4a' {
  const src: string
  export default src
}

interface ImportMetaEnv {
  readonly VITE_TRYSTERO_STRATEGY?: string
  readonly VITE_NOSTR_RELAYS?: string
  readonly VITE_TURN_URL?: string
  readonly VITE_TURN_USERNAME?: string
  readonly VITE_TURN_CREDENTIAL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

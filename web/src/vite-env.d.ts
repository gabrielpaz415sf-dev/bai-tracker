/// <reference types="vite/client" />

/**
 * Build-time flags. VITE_STATIC=1 switches api.ts to fetch pre-rendered JSON
 * files instead of a live Express origin — see resolveUrl() in api.ts.
 */
interface ImportMetaEnv {
  readonly VITE_STATIC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

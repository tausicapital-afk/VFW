/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute base URL of the VFW API (no trailing slash), e.g.
   * https://vfw-api.up.railway.app. Empty in local dev, where Vite proxies
   * /api to the backend instead.
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

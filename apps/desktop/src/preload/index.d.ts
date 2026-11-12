import type { PalApi } from './index'

declare global {
  interface Window {
    Pal: PalApi
  }
}

export {}

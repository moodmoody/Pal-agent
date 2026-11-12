import type { DevaApi } from './index'

declare global {
  interface Window {
    Pal: DevaApi
  }
}

export {}

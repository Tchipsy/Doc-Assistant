import { httpAdapter } from './httpAdapter'

/** 后端接口统一出口（纯 HTTP + SSE，无 mock）。 */
export const API_BASE = '/api'

export const api = httpAdapter

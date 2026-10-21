import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

/** Formato de `/pricing/services` (specs/clientes-e-negocios, fase 3). */
export type ServiceStats = {
  timesSold: number
  quantity: number
  revenueCents: number
  clients: number
  lastSoldOn: string | null
}

export type CatalogService = {
  id: number
  name: string
  description: string | null
  defaultPriceCents: number
  active: boolean
  sortOrder: number
  stats: ServiceStats
}

export type UncataloguedService = ServiceStats & { title: string }

export type ServicesResponse = {
  services: CatalogService[]
  uncatalogued: UncataloguedService[]
  assumptions: { base: string; receita: string; semCatalogo: string }
}

export function useServiceCatalog() {
  return useQuery({
    queryKey: ['services'],
    queryFn: () => api.get<ServicesResponse>('/pricing/services'),
    staleTime: 60_000,
  })
}

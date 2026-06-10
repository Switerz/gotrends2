// PT-BR labels for the `recommended_action` enum surfaced by the API. New
// keys returned by future skills are passed through unchanged so the UI
// never silently drops a value.

export const ACTION_LABELS: Record<string, string> = {
  increase_budget: 'Aumentar budget',
  reduce_budget: 'Reduzir budget',
  increase_troas_or_reduce_budget: 'Aumentar tROAS ou reduzir budget',
  optimize_efficiency: 'Otimizar eficiência',
  improve_ads_or_terms: 'Melhorar anúncios ou termos',
  review_landing_or_offer: 'Revisar landing ou oferta',
  monitor: 'Monitorar',
  pause: 'Pausar',
}

export function actionLabel(key: string): string {
  return ACTION_LABELS[key] ?? key
}

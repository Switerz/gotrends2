# GoTrends v2 - DATA_DICTIONARY

Sprint 0 inspecionou o banco `Data Mart` via Metabase API em 2026-06-08.

## Fonte principal

Tabela principal confirmada:

```text
raw.gogroup_google_ads
```

Tabelas auxiliares relevantes:

```text
raw.gogroup_google_ads_campaigns
raw.gogroup_google_ads_keywords
```

## Granularidade

`raw.gogroup_google_ads` esta em granularidade diaria por anuncio:

```text
date + company + campaign_id + ad_group_id + ad_id
```

Resultado do check:

| Metrica | Valor |
|---|---:|
| Linhas | 553370 |
| Periodo minimo | 2025-01-01 |
| Periodo maximo | 2026-06-07 |
| Datas distintas | 523 |
| Campanhas distintas | 526 |
| Ad groups distintos | 1867 |
| Ads distintos | 5831 |
| Chaves duplicadas | 0 |
| Maximo de linhas por chave | 1 |

Nao existe campo horario na tabela principal. `created_at` e `updated_at` sao timestamps de carga/atualizacao, nao devem ser usados como hora de performance.

## Qualidade inicial

| Check | Resultado |
|---|---:|
| `date` nulo | 0 |
| `campaign_id` nulo | 0 |
| `campaign_name` nulo/vazio | 0 |
| `ad_group_id` nulo | 0 |
| `ad_id` nulo | 0 |
| `cost` nulo | 0 |
| `revenue` nulo | 0 |
| `conversions` nulo | 0 |
| `impressions` nulo | 0 |
| `clicks` nulo | 0 |
| `cost < 0` | 0 |
| `clicks > impressions` | 54 |

As 54 linhas com `clicks > impressions` precisam ser investigadas antes de usar CTR como sinal decisorio.

## Campos da tabela principal

| Campo | Tipo | Uso inicial |
|---|---|---|
| `id` | int4 | Chave tecnica da linha |
| `date` | date | Data diaria da performance |
| `company` | varchar | Empresa/conta de negocio |
| `campaign_id` | int8 | Identificador da campanha |
| `campaign_name` | varchar | Nome da campanha |
| `channel_type_code` | int4 | Codigo do tipo de canal |
| `channel_type` | varchar | Proxy para `campaign_type` |
| `channel_sub_type` | int4 | Subtipo do canal |
| `ad_group_id` | int8 | Identificador do grupo de anuncio |
| `ad_group_name` | varchar | Nome do grupo de anuncio |
| `ad_id` | int8 | Identificador do anuncio |
| `ad_name` | varchar | Nome do anuncio |
| `cost` | float8 | Investimento |
| `orders` | int4 | Pedidos |
| `revenue` | float8 | Receita atribuida/real disponivel na tabela principal |
| `impressions` | int8 | Impressoes |
| `clicks` | int4 | Cliques |
| `ctr` | float8 | CTR existente; deve ser recalculado em views para consistencia |
| `avg_cpc` | float8 | CPC medio existente; deve ser recalculado em views para consistencia |
| `avg_cpv` | float8 | CPV medio |
| `avg_cpm` | float8 | CPM medio |
| `conversions` | float8 | Conversoes |
| `cost_per_conversion` | float8 | CPA existente; deve ser recalculado em views para consistencia |
| `video_views` | int4 | Views de video |
| `video_quartile_p100_rate` | float8 | Video completion rate 100% |
| `video_quartile_p25_rate` | float8 | Video quartile 25% |
| `video_quartile_p50_rate` | float8 | Video quartile 50% |
| `video_quartile_p75_rate` | float8 | Video quartile 75% |
| `video_view_rate` | float8 | Taxa de visualizacao de video |
| `created_at` | timestamp | Timestamp de carga |
| `updated_at` | timestamp | Timestamp de atualizacao |

## Mapeamento dos campos esperados

| Campo esperado | Status | Campo real encontrado | Observacao / impacto |
|---|---|---|---|
| `date` | Existe | `raw.gogroup_google_ads.date` | Base diaria confirmada |
| `hour` | Ausente | N/A | Bloqueia forecast intraday real; so e possivel forecast diario ou buscar outra fonte horaria |
| `campaign_id` | Existe | `campaign_id` | OK |
| `campaign_name` | Existe | `campaign_name` | OK |
| `campaign_type` | Derivavel | `channel_type` | Usar como tipo de campanha/canal |
| `ad_group_id` | Existe | `ad_group_id` | OK |
| `ad_group_name` | Existe | `ad_group_name` | OK |
| `search_term` | Ausente | N/A | Nao implementar Sprint 11 ainda; precisa outra tabela/fonte |
| `keyword` | Parcial em auxiliar | `raw.gogroup_google_ads_keywords.keyword_text` | Nao existe na principal; disponivel em tabela de keywords |
| `cost` | Existe | `cost` | OK |
| `impressions` | Existe | `impressions` | OK |
| `clicks` | Existe | `clicks` | OK, com alerta de 54 linhas `clicks > impressions` |
| `conversions` | Existe | `conversions` | OK |
| `conversion_value` | Auxiliar | `raw.gogroup_google_ads_campaigns.conversion_value`; `raw.gogroup_google_ads_keywords.conversion_value` | Na principal o campo equivalente e `revenue` |
| `revenue` | Existe | `revenue` | OK |
| `budget` | Ausente | N/A | Bloqueia `budget_consumption` real; precisa tabela de budget/campaign settings |
| `target_roas` | Ausente | N/A | Nao da para avaliar meta declarada; precisa outra fonte ou configuracao manual |
| `target_cpa` | Ausente | N/A | Nao da para avaliar meta declarada; precisa outra fonte ou configuracao manual |
| `impression_share` | Auxiliar | `raw.gogroup_google_ads_campaigns.search_impression_share` | Disponivel em nivel campanha para Search/Shopping, nao na principal |
| `lost_is_budget` | Auxiliar | `raw.gogroup_google_ads_campaigns.search_budget_lost_impression_share` | Disponivel em nivel campanha |
| `lost_is_rank` | Auxiliar | `raw.gogroup_google_ads_campaigns.search_rank_lost_impression_share` | Disponivel em nivel campanha |
| `status` | Auxiliar | `raw.gogroup_google_ads_campaigns.campaign_status` | Valores encontrados: `ENABLED`, `PAUSED` |
| `bidding_strategy` | Auxiliar | `raw.gogroup_google_ads_campaigns.bidding_strategy_type` | Valores encontrados: `TARGET_ROAS`, `MAXIMIZE_CONVERSION_VALUE`, `MAXIMIZE_CONVERSIONS`, `TARGET_CPA`, `MANUAL_CPC`, `TARGET_SPEND`, `TARGET_CPM` |
| campanha em aprendizado | Ausente | N/A | Nao existe indicador confiavel; precisa outra fonte |
| campanha de teste | Ausente confiavel | N/A | Pode haver convencao por nome, mas nao deve ser inferida sem regra documentada |

## Tabela auxiliar de campanhas

`raw.gogroup_google_ads_campaigns` tem 51444 linhas, de 2025-01-01 a 2026-06-07, com 560 campanhas distintas.

Campos importantes:

```text
date
company
campaign_id
campaign_name
campaign_status
channel_type
bidding_strategy_type
impressions
clicks
cost
conversions
conversion_value
search_impression_share
search_budget_lost_impression_share
search_rank_lost_impression_share
avg_impression_frequency_per_user
```

Linhas com share de impressao preenchido:

| Campo | Linhas preenchidas |
|---|---:|
| `search_impression_share` | 44028 |
| `search_budget_lost_impression_share` | 44028 |
| `search_rank_lost_impression_share` | 44028 |

## Decisao para proximos passos

Nao avancar para modelagem intraday ainda. A Sprint 1 pode criar metricas diarias por campanha usando `raw.gogroup_google_ads` agregada por `date + company + campaign_id + campaign_name + channel_type`, com joins pontuais na tabela de campanhas para status, bidding strategy e impression share.

O forecast intraday da Sprint 2 depende de uma fonte com hora real de performance. Sem `hour`, qualquer forecast EOD seria aproximacao diaria e nao atenderia ao objetivo original.

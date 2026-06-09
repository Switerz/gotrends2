# GoTrends v2 - Definicoes de Metricas

Sprint 1 cria a camada base de metricas por campanha usando dados diarios.

## Fonte

Tabela principal:

```text
raw.gogroup_google_ads
```

Tabela auxiliar:

```text
raw.gogroup_google_ads_campaigns
```

## `campaign_daily_metrics`

Arquivo:

```text
queries/01_campaign_daily_metrics.sql
```

Grao da saida:

```text
date + company + campaign_id
```

A tabela principal esta em nivel de anuncio, entao a query agrega primeiro por campanha/dia e so depois faz join com a tabela auxiliar de campanhas. Isso evita multiplicacao de linhas.

## Campos

| Campo | Definicao |
|---|---|
| `date` | Data diaria da performance |
| `company` | Empresa/conta de negocio |
| `campaign_id` | Identificador da campanha |
| `campaign_name` | Nome da campanha, priorizando a tabela auxiliar de campanhas |
| `campaign_type` | Tipo/canal da campanha, derivado de `channel_type` |
| `status` | Status da campanha em `raw.gogroup_google_ads_campaigns.campaign_status` |
| `bidding_strategy` | Estrategia em `raw.gogroup_google_ads_campaigns.bidding_strategy_type` |
| `cost` | Soma de `cost` no dia/campanha |
| `impressions` | Soma de `impressions` no dia/campanha |
| `clicks` | Soma de `clicks` no dia/campanha |
| `conversions` | Soma de `conversions` no dia/campanha |
| `conversion_value` | Soma de `revenue`, usada como valor de conversao enquanto nao houver outro campo confirmado |
| `revenue_real` | Soma de `revenue`; precisa ser revisada quando houver fonte separada de receita real |
| `budget` | `NULL`, porque budget nao foi encontrado na Sprint 0 |
| `target_roas` | `NULL`, porque target ROAS nao foi encontrado na Sprint 0 |
| `target_cpa` | `NULL`, porque target CPA nao foi encontrado na Sprint 0 |
| `impression_share` | `search_impression_share` da tabela auxiliar |
| `lost_is_budget` | `search_budget_lost_impression_share` da tabela auxiliar |
| `lost_is_rank` | `search_rank_lost_impression_share` da tabela auxiliar |
| `source_ad_rows` | Quantidade de linhas de anuncios agregadas |
| `ad_groups` | Quantidade de ad groups distintos agregados |
| `ads` | Quantidade de anuncios distintos agregados |

## Derivacoes

Todas as divisoes usam `NULLIF(denominador, 0)`.

| Metrica | Formula |
|---|---|
| `ctr` | `clicks / impressions` |
| `cpc` | `cost / clicks` |
| `cvr` | `conversions / clicks` |
| `roas` | `conversion_value / cost` |
| `budget_consumption` | `NULL`, porque `budget` nao existe na fonte atual |

## `campaign_hourly_metrics`

Arquivo:

```text
queries/02_campaign_hourly_metrics.sql
```

Status:

```text
PENDING
```

Nao existe campo `hour` na fonte atual. `created_at` e `updated_at` sao timestamps de carga/atualizacao e nao devem ser usados como hora de performance. O arquivo horario preserva o schema esperado com uma query vazia e documenta o bloqueio.

## Testes de consistencia

Checks executados na Sprint 1:

| Check | Resultado |
|---|---:|
| Linhas em `campaign_daily_metrics` | 50365 |
| Datas nulas | 0 |
| Custo negativo | 0 |
| Linhas com `clicks > impressions` | 1 |
| Linhas com `cost = 0` e `roas` nao nulo | 0 |
| Linhas sem match na auxiliar de campanhas | 642 |
| Custo total agregado | 33966866.72 |
| Valor de conversao total agregado | 555612898.32 |

Interpretacao:

- O check de `roas` confirma que a divisao por zero esta segura.
- A linha agregada com `clicks > impressions` deve permanecer como alerta de qualidade antes de usar CTR para decisao.
- As 642 linhas sem match na auxiliar mantem metricas de performance, mas ficam sem `status`, `bidding_strategy` e impression share.

## Limitacoes atuais

- Sem `hour`, nao ha metricas horarias reais.
- Sem `budget`, nao ha `budget_consumption`.
- Sem `target_roas` e `target_cpa`, ainda nao ha comparacao contra metas declaradas.
- Sem fonte separada de receita real, `revenue_real` usa o mesmo valor de `revenue`.

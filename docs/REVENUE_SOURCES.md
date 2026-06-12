# GoTrends v2 — Revenue Sources (multi-company)

> Como ligar uma conta Google Ads a uma fonte de receita real (Yampi,
> Shopify, etc.) em vez do proxy `conversion_value` do Google Ads.

## Motivação

O pipeline hoje usa `raw.gogroup_google_ads.conversion_value` como proxy
de receita. Isso tem dois problemas:

1. **Conversion value** é o que o Google Ads observa via tag de conversão
   — sujeita a perda (cookie bloqueado, GDPR consent, etc.)
2. **Não inclui pedidos manuais** (atendimento, suporte recuperando
   carrinho) que existem no e-commerce mas não passam pela tag.

A receita real está no e-commerce. Para cada conta, configuramos qual
provider buscar (Yampi pra Apice; outros providers no futuro).

## Arquitetura

```
src/
├── config/
│   └── revenueSources.ts     ← MAP account_id → { provider, alias, credentialsRefs }
├── clients/
│   └── yampi.ts              ← REST client (User-Token + User-Secret-Key)
└── pipeline/
    └── runModels.ts          ← (FUTURO) substitui conversion_value pela receita Yampi
                                 via UTM mapping orders → campaigns
```

**Credenciais NUNCA ficam neste repo.** O arquivo `revenueSources.ts`
carrega só o NOME do env var; os valores vivem no Godeploy via
`setAppSecret`. Trocar uma credencial = `setAppSecret` + nada no código.

## Adicionar uma conta nova

1. **Setar secrets no Godeploy** com nomes consistentes:
   ```text
   {PROVIDER}_{COMPANY}_USER_TOKEN
   {PROVIDER}_{COMPANY}_USER_SECRET_KEY
   ```
   Ex.: `YAMPI_GOCASE_USER_TOKEN`, `YAMPI_GOCASE_USER_SECRET_KEY`.

2. **Adicionar a entrada em `config/revenueSources.ts`**:
   ```ts
   '12345678901': {                  // account_id do Google Ads
     provider: 'yampi',
     alias: 'gocase-store',          // URL slug em api.dooki.com.br/v2/{alias}
     credentials: {
       userTokenEnv: 'YAMPI_GOCASE_USER_TOKEN',
       userSecretKeyEnv: 'YAMPI_GOCASE_USER_SECRET_KEY',
     },
   },
   ```

3. **Adicionar os env vars ao Env interface** (`src/index.ts`) — mantém
   TypeScript honesto sobre o que pode existir em runtime.

4. **Deploy** — pipeline já tem acesso ao client por account.

Contas que não estão no mapa caem no proxy de Google Ads (compat).

## Provider Yampi

API: `https://api.dooki.com.br/v2/{alias}/...`

**Auth (headers obrigatórios):**

```http
User-Token: usWOQJ...
User-Secret-Key: sk_YkiM...
```

**Endpoints usados:**

| Endpoint | Para que |
|---|---|
| `GET /orders?status_alias=paid&date_min&date_max&limit&page` | Pedidos pagos no período, com paginação |

A query string filtra:
- `status_alias=paid` → só pedidos finalizados com pagamento confirmado
- `date_min` / `date_max` → faixa inclusiva (YYYY-MM-DD)
- `limit` (≤100) + `page` → cliente paginha até página curta

**Campos relevantes na resposta** (validados contra a API real em 2026-06-12):

```ts
{
  id: 164823846,
  created_at: { date: '2026-06-12 15:00:12.000000' },  // wrapped object
  value_total: 201.43,                                  // BRL líquido (com desconto + frete)
  value_products: 226.71,
  value_discount: 37.18,
  value_shipment: 11.9,

  // UTMs aparecem TOP-LEVEL no order, não em metadata.data
  utm_source: 'facebook',
  utm_medium: 'paid',
  utm_campaign: 'Conversão - Valor - CUPOM',
  utm_term: '120221002675910393',
  utm_content: 'video-creative-x'
}
```

O client (`clients/yampi.ts`) normaliza para um `YampiOrder` enxuto:

```ts
interface YampiOrder {
  id: number
  createdAt: string | null  // raw created_at.date
  totalBrl: number          // value_total
  utm: { source, medium, campaign, term, content: string | null }
}
```

O resto do código nunca toca a shape crua do Yampi — change-resilient.

## Próximo passo (não entregue neste commit)

Wire-up no pipeline:

1. Para cada `runModelsForAccount`, se `getRevenueSource(accountId)` retorna
   config → instancia `YampiClient` com credenciais do env
2. `fetchPaidOrders` para a janela `[windowStart, windowEnd]`
3. **UTM mapping**: agregar `orders[].totalBrl` por `(date, utm_campaign)`,
   converter `utm_campaign` para `campaign_id` (mapping table no DB ou
   convenção de naming)
4. Substituir `conversion_value` pelo agregado real em `dailyEnriched`

O passo 3 é o desafio — Yampi não conhece `campaign_id`; só conhece
`utm_campaign` que o usuário tagou na URL. Pode dar **mapping ambíguo**
ou **órfãos** (orders sem UTM). Estratégias possíveis:

- Convenção: o time de tráfego garante que `utm_campaign = campaign_id`
  (impositivo, exige disciplina)
- Tabela de mapeamento `campaign_utm_map` (flexível, exige manutenção)
- Fallback: orders sem UTM viram revenue "geral" (atribuição menos
  agressiva, mais defensável)

Decisão a tomar antes do wire-up.

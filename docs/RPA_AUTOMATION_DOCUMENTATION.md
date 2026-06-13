# GoTrends v2 - Documentacao da Automacao/RPA

## 1. Resumo executivo

O GoTrends v2 e uma automacao de inteligencia operacional para campanhas de Google Ads da Apice/GoGroup. O sistema coleta dados de performance, executa modelos estatisticos deterministas, gera recomendacoes de otimizacao, envia essas recomendacoes para aprovacao humana e, quando aprovadas, aplica alteracoes operacionais via Google Ads API.

A automacao foi desenhada com o principio de "humano no controle": os modelos identificam oportunidades e riscos, a camada de LLM apenas explica as recomendacoes, e a execucao depende de aprovacao explicita por Chat ou interface web. Guardrails tecnicos impedem mudancas agressivas, reduzem risco de instabilidade em Smart Bidding e mantem trilha de auditoria sobre decisoes, aprovacoes, execucoes e resultados.

## 2. Objetivo do projeto

O objetivo do GoTrends v2 e transformar a rotina manual de analise e otimizacao de campanhas em um fluxo automatizado, auditavel e governado. Em vez de depender de revisoes pontuais em planilhas ou na interface do Google Ads, o sistema executa diariamente um pipeline que:

- identifica campanhas com sinais de oportunidade, anomalia ou saturacao;
- calcula recomendacoes de budget, tROAS ou acao operacional;
- classifica risco, confianca e impacto esperado;
- envia cards para aprovacao humana no Google Chat;
- aplica a mudanca aprovada por API;
- verifica posteriormente se a alteracao realmente permaneceu no Google Ads;
- mede outcomes de 24h e 72h contra o esperado.

## 3. Escopo da automacao

### Dentro do escopo

- Coleta de dados de campanhas, metricas de Ads e dados de receita.
- Enriquecimento com configuracoes reais de campanha, como budget, target ROAS e estrategia de lances.
- Execucao de modelos deterministicos para tendencia, anomalia, confianca, elasticidade marginal, saturacao, diagnostico de alavanca, score de campanha e backtesting.
- Geracao de recomendacoes estruturadas.
- Aplicacao de guardrails antes de qualquer recomendacao ficar disponivel ao operador.
- Envio de recomendacoes aprovaveis para Google Chat.
- Aprovacao ou rejeicao por humano.
- Execucao via Google Ads API apos aprovacao.
- Persistencia de trilha de auditoria em banco.
- Verificacao pos-execucao para detectar drift, rollback manual ou concorrencia operacional.

### Fora do escopo atual

- Execucao sem aprovacao humana.
- Guardrails baseados em listas manuais de bloqueio.
- Quiet hours para impedir operacao em horarios especificos.
- Limites cumulativos de budget, por decisao tecnica atual; os caps cumulativos sao aplicados a tROAS.

## 4. Arquitetura de alto nivel

O sistema vivo roda em `app/` como worker TypeScript implantado via Godeploy. A arquitetura separa decisao, explicacao, orquestracao, persistencia, integracoes externas e interface.

| Camada | Responsabilidade | Local no repositorio |
|---|---|---|
| Modelos deterministicos | Calculos estatisticos e regras quantitativas sem IO | `app/src/models/` |
| Pipeline | Orquestracao dos jobs, coleta, modelagem, persistencia e envio | `app/src/pipeline/` |
| Agent/refiner | Validacao, enriquecimento, guardrails e explicacao textual | `app/src/agent/` |
| Integracoes | Google Ads, Google Chat, Metabase e demais clientes externos | `app/src/clients/` |
| Persistencia | Runs, recomendacoes, aprovacoes, execucoes e outcomes | `app/src/db/` |
| HTTP/API | Rotas de cron, aprovacao, execucao e consulta | `app/src/http/` |
| Interface | SPA React para acompanhamento operacional | `app/client/` |

Principio arquitetural central: a LLM nao decide. A decisao vem de modelos deterministicos e estatisticos. A LLM, quando usada, apenas melhora a explicacao para o operador.

## 5. Fluxo operacional da RPA

### 5.1 Execucao diaria dos modelos

O job `run-models`, executado por cron, inicia o ciclo operacional. Ele busca dados das fontes configuradas, calcula sinais de negocio e gera candidatos a recomendacao.

Etapas principais:

1. Coleta dados de campanha e performance.
2. Executa modelos de tendencia, anomalia, confianca, elasticidade e saturacao.
3. Gera candidatos de recomendacao com acao, magnitude, impacto esperado e risco.
4. Remove recomendacoes antigas em estado operacional aberto quando ficam stale.
5. Evita duplicidade para campanhas que ja possuem recomendacao ativa.
6. Aplica cooldown para recomendacoes rejeitadas recentemente.
7. Envia cada candidato valido ao refiner.

### 5.2 Refino e guardrails

Antes de ser persistida, toda recomendacao passa por `refine()`. Esse passo valida o contrato de dados, enriquece campos derivados e aplica a cadeia de guardrails.

Veredictos possiveis:

| Veredicto | Significado operacional |
|---|---|
| `ok` | Pode ser enviada como card aprovavel ao operador |
| `needs_human_review` | Exige revisao humana com motivo explicito |
| `blocked` | Fica registrada, mas nao deve ser aprovada via Chat |

Guardrails implementados:

- bloqueio de mudancas acima de 50%;
- revisao humana para baixa confianca estatistica;
- revisao humana para anomalias criticas;
- revisao humana para risco alto;
- cap diario de drift de tROAS;
- cap rolling de 7 dias de drift de tROAS;
- verificacao de fase de aprendizado ou limitacao do Smart Bidding;
- deduplicacao de recomendacoes ativas;
- cooldown para recomendacoes rejeitadas recentemente.

### 5.3 Envio para Google Chat

Recomendacoes elegiveis sao enviadas ao Google Chat como cards operacionais. O card apresenta:

- campanha impactada;
- acao recomendada;
- impacto esperado;
- nivel de risco;
- confianca;
- status dos guardrails;
- botoes de aprovacao ou rejeicao quando aplicavel.

Recomendacoes bloqueadas nao recebem fluxo de aprovacao via Chat. Elas ficam visiveis para auditoria e investigacao na SPA.

### 5.4 Aprovacao humana

O operador pode aprovar ou rejeitar a recomendacao por Chat ou pela interface web. A aprovacao e registrada em banco com metadados de auditoria, incluindo recomendacao, status, origem e timestamp.

Essa etapa garante que a automacao atua como copilot operacional e nao como executor autonomo irrestrito.

### 5.5 Execucao via Google Ads API

Apos aprovacao, o executor aplica a alteracao no Google Ads. A execucao pode alterar configuracoes como budget ou target ROAS conforme a recomendacao aprovada.

O resultado da execucao e persistido, permitindo rastrear:

- recomendacao de origem;
- campanha afetada;
- valor proposto;
- status da execucao;
- erro, quando houver;
- horario de conclusao.

### 5.6 Verificacao pos-execucao

Um cron de verificacao roda de 6 em 6 horas para confirmar se a mudanca aplicada permanece no Google Ads. O sistema le o estado vivo da campanha via GAQL e compara com o valor proposto.

Estados de verificacao:

| Estado | Criterio | Interpretacao |
|---|---|---|
| `match` | Diferenca ate 1% | Alteracao aplicada conforme esperado |
| `drifted` | Diferenca acima de 1% e ate 10% | Possivel arredondamento, concorrencia ou pequena divergencia |
| `reverted` | Diferenca acima de 10% | Possivel rollback manual ou sobrescrita relevante |
| `unavailable` | Leitura indisponivel | Nao foi possivel verificar o estado |

### 5.7 Medicao de outcomes

Jobs de outcome comparam realizado versus esperado em janelas de 24h e 72h. Esse feedback fecha o ciclo de governanca e permite analisar se as recomendacoes geraram impacto compativel com o previsto.

## 6. Fontes de dados e integracoes

| Fonte/integracao | Uso no processo |
|---|---|
| Metabase/Data Mart | Base historica de campanhas, custos, receita e performance |
| Google Ads API | Leitura de configuracoes e metricas, alem de mutacoes aprovadas |
| Google Chat | Canal de notificacao, aprovacao e rejeicao operacional |
| Banco do worker | Persistencia de runs, recomendacoes, aprovacoes, execucoes e outcomes |
| SPA React | Interface de consulta, decisao e auditoria |

Tabelas de referencia documentadas no projeto:

- `raw.gogroup_google_ads`
- `raw.gogroup_google_ads_campaigns`
- `raw.gogroup_google_ads_keywords`
- `raw.ga4_gogroup_all_channels`

## 7. Controles, seguranca e governanca

### Humano no loop

Nenhuma recomendacao sensivel deve ser executada sem aprovacao. O operador revisa contexto, risco e impacto esperado antes da acao.

### Guardrails tecnicos

Mudancas excessivas sao bloqueadas, sinais de baixa confianca exigem revisao, e alteracoes de tROAS respeitam limites cumulativos para reduzir risco de reset ou instabilidade do Smart Bidding.

### Auditoria ponta a ponta

O sistema registra:

- execucao de runs;
- recomendacoes geradas;
- status de guardrails;
- aprovacoes e rejeicoes;
- execucoes na API;
- verificacoes pos-execucao;
- outcomes de performance.

### Separacao de responsabilidades

Modelos fazem calculo. Pipeline orquestra. Refiner valida e aplica guardrails. Executor aplica apenas o que foi aprovado. Interface e Chat expõem a decisao para operador humano.

## 8. Evidencias recomendadas para anexar no formulario

Para o campo "Upload de arquivos", a recomendacao e enviar um PDF principal gerado a partir deste Markdown e, se o formulario permitir multiplos anexos, incluir evidencias complementares.

Arquivos/evidencias recomendados:

| Evidencia | Finalidade |
|---|---|
| PDF deste documento | Documento principal da automacao/RPA |
| Prints do Google Chat | Demonstrar fluxo de notificacao e aprovacao |
| Prints da SPA | Demonstrar acompanhamento, status e auditoria |
| Print ou trecho de logs de cron | Demonstrar execucao automatica recorrente |
| Diagrama simples do fluxo | Facilitar avaliacao por banca nao tecnica |
| Trechos de codigo dos jobs e guardrails | Comprovar implementacao tecnica |

Formato recomendado para submissao:

1. PDF como documento principal, pois preserva formatacao e e mais seguro para avaliacao.
2. Markdown como fonte versionada no repositorio.
3. PNG/JPG para prints de tela.
4. Trechos de codigo apenas se solicitados ou se houver campo para anexos tecnicos adicionais.

## 9. Descricao tecnica complementar para o formulario

Texto sugerido para o campo opcional "Descricao tecnica complementar":

```text
O GoTrends v2 automatiza o ciclo de analise, recomendacao, aprovacao e execucao de otimizacoes em campanhas de Google Ads. O pipeline roda por cron em um worker TypeScript, coleta dados de performance e configuracao, executa modelos deterministicos de tendencia, anomalia, confianca, elasticidade e saturacao, gera recomendacoes estruturadas e aplica uma cadeia de guardrails antes de disponibilizar qualquer acao ao operador.

A decisao e governada por humano no loop: recomendacoes aprovaveis sao enviadas ao Google Chat e tambem ficam disponiveis na SPA. Apos aprovacao, o sistema executa a mudanca via Google Ads API, registra a execucao e roda verificacao pos-execucao para confirmar se o valor aplicado permaneceu no Google Ads. A arquitetura separa modelos, pipeline, refiner/guardrails, clientes externos, persistencia e interface, mantendo auditoria de runs, recomendacoes, aprovacoes, execucoes e outcomes de 24h/72h.
```

## 10. Referencias internas do projeto

- `README.md` - visao geral do GoTrends v2.
- `docs/ARCHITECTURE.md` - arquitetura canonica do repositorio.
- `docs/GUARDRAILS.md` - cadeia de guardrails e veredictos operacionais.
- `docs/VERIFICATION.md` - verificacao pos-execucao.
- `docs/GOOGLE_ADS_API_INTEGRATION.md` - integracao com Google Ads API.
- `docs/METRICS_DEFINITIONS.md` - definicoes de metricas.
- `DATA_DICTIONARY.md` - fontes de dados e dicionario de tabelas.

## 11. Checklist de qualidade para submissao

- Documento principal exportado em PDF.
- Nome do arquivo claro, por exemplo `GoTrends_v2_Documentacao_RPA.pdf`.
- Prints com dados sensiveis ocultados quando necessario.
- Fluxo de ponta a ponta demonstrado: cron, recomendacao, aprovacao, execucao, verificacao e outcome.
- Evidencia de governanca: guardrails, aprovacao humana e auditoria.
- Descricao tecnica complementar colada no campo opcional do formulario.

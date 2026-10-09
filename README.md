# Conty. Métricas das redes do criador

Serviço que recebe uma conexão já autorizada (Instagram, TikTok, YouTube ou X) e sincroniza views, curtidas e comentários dos posts, sem contar o mesmo post duas vezes e sem brigar com o limite de taxa do provedor.

## Como rodar

Node 22 ou mais novo.

```bash
npm install
npm test
npm run dev
```

A API sobe em `http://127.0.0.1:3004` com um provedor simulado: dez posts de março de 2026, e a primeira sincronização depois de subir sofre um timeout e um 429 de 2 segundos antes de dar certo. Não há OAuth; o token é fictício.

```bash
curl -s -X POST localhost:3004/connections -H 'content-type: application/json' \
  -d '{"platform":"instagram","account_id":"ana","access_token":"token-ficticio"}'

curl -s -X POST localhost:3004/connections/<id>/sync -H 'content-type: application/json' \
  -d '{"since":"2026-03-01T00:00:00Z","until":"2026-03-10T00:00:00Z"}'

curl -s localhost:3004/connections/<id>/metrics
```

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3004` | porta |
| `DB_PATH` | `data/metricas.sqlite` | banco |
| `SYNC_MAX_ATTEMPTS` | `4` | tentativas por chamada ao provedor, contando a primeira |
| `SYNC_MAX_WAIT_MS` | `60000` | teto de qualquer espera |
| `SYNC_BASE_DELAY_MS` | `500` | primeira espera do backoff |

## Por onde ler

1. `src/provider.ts`: a fronteira. A interface `MetricsProvider`, o formato do snapshot e os três tipos de erro.
2. `src/sync.ts`: a regra de negócio. Não sabe o que é HTTP nem qual rede está do outro lado.
3. `src/retry.ts`: retry, backoff, Retry-After e os tetos.
4. `src/fake-provider.ts`: o provedor falso, que só implementa a interface.
5. `test/sync.test.ts` e `test/retry.test.ts`.

Trocar o provedor falso por um real é escrever outra classe que implemente `MetricsProvider` e traduza as respostas HTTP para `RateLimitedError`, `TransientProviderError` ou `PermanentProviderError`. `parseRetryAfter` já lê o cabeçalho em segundos ou em data HTTP.

## Idempotência

O provedor devolve **snapshots**: a leitura dos contadores de um post num instante (`captured_at`). Os números são totais acumulados, não incrementos.

- A chave de um snapshot é (conexão, post, `captured_at`). O mesmo snapshot entra uma vez, venha repetido na mesma resposta, numa segunda sincronização da mesma janela ou numa janela que se sobrepõe à anterior.
- O número atual de um post é o do snapshot com o maior `captured_at`. Uma medição mais nova **substitui** a anterior; nunca soma com ela.
- Uma medição antiga que chega depois entra no histórico e não rebaixa o número atual.
- O total da conexão soma um snapshot por post, então um post visto em três janelas conta uma vez.

O campo `snapshots_new` de cada execução diz quantos snapshots eram novidade. Na sincronização de uma janela sobreposta, ele é menor que `snapshots_received`.

## Quando a métrica foi buscada

Cada post na resposta de métricas traz três datas:

- `captured_at`: quando o provedor mediu o número mostrado.
- `fetched_at`: quando esse snapshot foi buscado por nós.
- `last_fetched_at`: a última vez em que o post apareceu numa sincronização, mesmo sem número novo.

`GET /connections/:id/sync-runs` lista todas as execuções com janela, status, tentativas e tempo esperado.

## Falha transitória e 429

O retry é por chamada ao provedor (por página):

| O provedor responde | O serviço faz |
|---|---|
| timeout, conexão caída, 5xx | espera 500 ms, 1 s, 2 s (dobrando até o teto) e tenta de novo |
| 429 com `Retry-After` até o teto | espera exatamente o prazo pedido e tenta de novo |
| 429 com `Retry-After` acima do teto | não espera: encerra como `rate_limited` e devolve o prazo pedido |
| 429 sem `Retry-After` | usa o backoff |
| token inválido e outros erros permanentes | não tenta de novo |

Dois tetos valem sempre: `SYNC_MAX_ATTEMPTS` tentativas por chamada, contando 429 e falhas juntos, e `SYNC_MAX_WAIT_MS` por espera. Não há caminho que tente para sempre.

Quando o `Retry-After` passa do teto, esperar só até o teto renderia outro 429. Por isso a sincronização para, grava a execução como `rate_limited` com `retry_after_ms` e a API responde `503` com o cabeçalho `Retry-After`. Quem chamou decide quando voltar.

Se uma página falha depois de outras já gravadas, o que entrou fica. Sincronizar a mesma janela de novo é seguro por causa da idempotência.

O teste do 429 (`test/sync.test.ts`, "limite de taxa") usa um relógio controlado em que dormir só avança o tempo, e confere que o intervalo entre início e fim da execução é exatamente o `Retry-After`.

## API

| Rota | Faz |
|---|---|
| `POST /connections` | registra a conexão (`platform`, `account_id`, `access_token`); o token não volta na resposta |
| `POST /connections/:id/sync` | sincroniza a janela `since` (inclusivo) a `until` (exclusivo), por data de publicação |
| `GET /connections/:id/metrics` | número atual de cada post, totais e datas de busca |
| `GET /connections/:id/sync-runs` | histórico das execuções |

`POST /sync` responde `200` com a execução, `502 provider_failed` quando as tentativas se esgotam e `503 provider_rate_limited` quando o provedor pede uma espera acima do teto. Nos dois erros o corpo traz a execução gravada em `run`.

Resposta de uma sincronização que passou por um 429 de 30 segundos:

```json
{
  "id": "run_5f0c…",
  "connection_id": "con_91ab…",
  "window_since": "2026-03-01T00:00:00.000Z",
  "window_until": "2026-03-10T00:00:00.000Z",
  "status": "succeeded",
  "attempts": 2,
  "waited_ms": 30000,
  "snapshots_received": 3,
  "snapshots_new": 3,
  "error": null,
  "retry_after_ms": null,
  "started_at": "2026-03-20T12:00:00.000Z",
  "finished_at": "2026-03-20T12:00:30.000Z"
}
```

## O que ficou de fora

- **Timeout de verdade.** O provedor falso simula timeout lançando `TransientProviderError`. Um cliente HTTP real precisa de `AbortSignal.timeout` e de traduzir o abort para esse erro.
- **Sincronização síncrona.** `POST /sync` segura a requisição enquanto espera o `Retry-After`. Em produção isso seria um job em fila, com a API só consultando a execução.
- **Concorrência.** Duas sincronizações simultâneas da mesma conexão não se duplicam, por causa da chave do snapshot, mas disputam o mesmo limite de taxa; falta um lock por conexão.
- **Jitter no backoff** e orçamento de taxa compartilhado entre conexões do mesmo provedor.
- **Post apagado na rede** continua nas métricas com o último número conhecido.
- **Token em texto puro** no banco, sem renovação. OAuth não faz parte do desafio.
- **Item malformado do provedor é ignorado** sem registro na execução.

## Uso de IA

O código, os testes e este README foram escritos com Claude Code (Claude Opus), a partir do enunciado. O modelo de snapshot e a decisão sobre `Retry-After` acima do teto foram propostos pela IA.

O que eu revisei: <preencher antes de enviar, só com o que foi de fato conferido>.

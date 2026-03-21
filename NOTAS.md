# Notas do Projeto — Agente IA Casa Faria Cohama

> Arquivo de anotações técnicas para uso interno (Claude Code).
> Atualizado em: 2026-03-21

---

## 1. O QUE É ESSE PROJETO

Agente de atendimento via WhatsApp para a **Casa Faria Cohama** — loja de equipamentos para food service em São Luís, MA. O agente responde clientes automaticamente, consulta estoque e preços no ERP Linx Microvix, e passa o cliente para um atendente humano quando há intenção de compra.

**Stack:**
- Node.js (ES modules, single-file `server.js`)
- Express (webhook + rotas admin)
- Anthropic Claude API (`claude-sonnet-4-20250514`) com agentic loop
- Z-API (WhatsApp unofficial API)
- Groq Whisper API (transcrição de áudio)
- Linx Microvix B2C (ERP, API XML)
- Docker Compose (produção)

---

## 2. ARQUITETURA

```
WhatsApp (cliente)
    │
    ▼
Z-API → POST /webhook/whatsapp
    │
    ▼
server.js
    ├── rate limit (15 chamadas/hora por número)
    ├── debounce (1500ms) — agrupa mensagens rápidas
    ├── fila por telefone — evita condição de corrida
    ├── anti-ban (leitura + jitter + tempo mínimo)
    ├── verificarHorarioFuncionamento() — injeta contexto no prompt
    ├── executarAgente() — loop até 10 iterações
    │       ├── Claude API (tool_use / end_turn)
    │       └── tool dispatch → Microvix API calls
    └── enviarResposta() — texto + imagens separados
```

**Sessões:** Map em memória, persistido em `./data/sessoes.json` (volume Docker).
Campos por sessão: `historico`, `nome`, `telefone`, `pausado`, `pausadoEm`, `alertaEnviado`.

---

## 3. O QUE FOI IMPLEMENTADO

### 3.1 Core do agente
- [x] Agentic loop (`executarAgente`) com até 10 iterações
- [x] Ferramentas Microvix: `consultar_produtos_por_nome`, `consultar_estoque_por_codigo`, `consultar_preco_por_codigo`, `consultar_promocao_por_codigo`, `consultar_imagens_por_codigo`, `consultar_produtos_por_referencia`
- [x] System prompt completo com regras de venda, descontos PJ/PF, horários, entrega
- [x] Detecção de nome do cliente (`detectarNome`) com lista `NAO_SAO_NOMES` para evitar falsos positivos
- [x] Truncamento de histórico (`truncarHistorico`) com fix para evitar `tool_result` órfão no início
- [x] Identidade da Fari — agente se apresenta como "Fari, atendente virtual da Casa Faria" na primeira mensagem de cada conversa

### 3.2 WhatsApp (Z-API)
- [x] Migração de Evolution API → Z-API (motivação: Evolution API v2.2.3 não suporta LIDs nativamente)
- [x] `enviarTexto`, `enviarImagem`, `simularDigitando`, `ligarParaAtendente`
- [x] `marcarLida(telefone, messageId)` — mark as read antes de responder (anti-ban)
- [x] Extração e envio separado de imagens da resposta do Claude (`extrairUrlsImagem`)
- [x] Filtro de newsletters, grupos, mensagens próprias (`fromMe`)

### 3.3 Mídia
- [x] Áudio/PTT: transcrição via Groq Whisper (`whisper-large-v3-turbo`, pt-BR)
- [x] Imagem: download + encode base64 + envio como bloco multimodal para Claude vision
- [x] Limpeza de imagens do histórico após resposta (evita tokens excessivos)

### 3.4 Debounce
- [x] Janela de 1500ms (`DEBOUNCE_MS`) que agrupa mensagens enviadas em sequência rápida
- [x] `messageId` da última mensagem do lote salvo no estado do debounce para `marcarLida`

### 3.5 Fila por telefone
- [x] `processarNaFila(telefone, fn)` — Promise chain por número, evita condição de corrida no histórico

### 3.6 Cache Microvix
- [x] Cache TTL 10min para catálogo completo (`microvix:catalogo`) e imagens (`microvix:imagens`)
- [x] `cachePegar` / `cacheSalvar` com expiração por timestamp

### 3.7 Persistência de sessões
- [x] `carregarSessoes()` / `salvarSessoes()` — JSON em `SESSOES_FILE` (padrão: `./data/sessoes.json`)
- [x] Volume Docker `./data:/app/data` mapeado no compose

### 3.8 Handoff humano
- [x] Ferramenta `chamar_atendente` — pausa bot, notifica grupo/número da equipe
- [x] Notificação ao grupo inclui: número do cliente, link wa.me clicável, nome (se detectado), resumo formatado
- [x] Sessão marcada `pausado: true` + `pausadoEm: timestamp`
- [x] Retomada automática por tempo (`AUTO_RESUME_HORAS`, padrão: 4h)
- [x] Retomada via palavra-chave no fromMe: texto contendo "atendimento encerrado"
- [x] Retomada via comando da equipe: atendente envia "retomar XXXXXXXXXX" no WhatsApp
- [x] Retomada via endpoint admin: `POST /admin/retomar/:telefone`
- [x] Timer de vigilância (`setInterval` a cada 1min) — após `ALERTA_SEM_ATENDIMENTO` minutos (padrão: 30min) sem atendimento: envia desculpas ao cliente, alerta urgente no grupo, liga para `NUMERO_EQUIPE`
- [x] Após handoff, mensagem ao cliente informa **quando** o vendedor vai retornar (calculado dinamicamente: "segunda-feira às 8h", "amanhã às 8h", etc.)

### 3.9 Anti-ban
- [x] `randomEntre(min, max)` — helper de jitter
- [x] Delay aleatório 500–1200ms antes de marcar como lido
- [x] `marcarLida()` com Z-API `/read-message`
- [x] Tempo de digitação com ±25% de jitter (`Math.floor(base * randomEntre(75,125) / 100)`)
- [x] Tempo mínimo de resposta garantido: 3000ms desde o recebimento da mensagem

### 3.10 Admin
- [x] `POST /admin/pausar/:telefone` — pausa bot manualmente
- [x] `POST /admin/retomar/:telefone` — retoma bot manualmente
- [x] `GET /admin/sessoes` — lista sessões ativas/pausadas
- [x] Autenticação por `x-admin-token` header (configurável via `ADMIN_TOKEN`)

### 3.11 Reset
- [x] Keywords de reset: "nova conversa", "reiniciar", "resetar", "/reset", "limpar"
- [x] Deleta sessão e responde confirmando reinício

### 3.12 Retry
- [x] `comRetry(fn, tentativas=2, delayMs=1000)` — backoff linear nas chamadas ao Microvix

### 3.13 Horário de funcionamento inteligente
- [x] `verificarHorarioFuncionamento()` — calcula se está dentro do expediente (Seg–Sex 8h–18h, Sáb 8h–16h, timezone `America/Sao_Paulo`)
- [x] Fora do horário: Claude continua atendendo normalmente (não bloqueia), recebe contexto no system prompt informando que está fechado e quando reabre
- [x] Fari avisa o cliente na primeira mensagem fora do horário, mas responde dúvidas, consulta produtos, preços e estoque normalmente
- [x] Se cliente virar lead qualificado fora do horário: `chamar_atendente` é chamado normalmente e mensagem ao cliente informa o próximo horário de atendimento
- [x] `proximoAtendimento` calculado dinamicamente: "hoje às 8h", "amanhã às 8h", "segunda-feira às 8h" etc.

### 3.14 Rate limiting
- [x] `incrementarRateLimit(telefone)` — janela deslizante de 1 hora, limite de 15 chamadas ao Claude por número
- [x] Ao atingir o limite: avisa o cliente ("Recebi muitas mensagens... vou passar para um atendente"), notifica o grupo da equipe, pausa o bot para aquele número
- [x] Mensagem ao cliente inclui quando o atendente vai retornar (usa `proximoAtendimento` do horário atual)
- [x] Janela reseta automaticamente após 1 hora

### 3.15 Detecção de nomes — melhorias
- [x] Adicionados verbos imperativos à `NAO_SAO_NOMES`: "manda", "passa", "faz", "traz", "liga", "chama", "diz", "dá" (evita falsos positivos como "Manda a loc")

---

## 4. EM TESTE

- **Identidade Fari** — apresentação na primeira mensagem, comportamento fora do horário comercial
- **Horário fora do expediente** — Fari atendendo e informando corretamente quando o vendedor vai retornar
- **Rate limiting** — limite de 15 chamadas/hora com handoff automático ao atingir o limite
- **Notificação ao atendente** — formato enriquecido com wa.me e nome do cliente

---

## 5. BUGS CONHECIDOS

### ✅ RESOLVIDO — chamar_atendente não estava sendo chamado como tool_use
Confirmado funcionando em 2026-03-21 nos logs de produção. Claude chama a ferramenta corretamente ao detectar intenção de compra com produto + quantidade + PJ/PF + pagamento.

### 🟡 MÉDIO — Conta Z-API em trial
**Sintoma:** Todas as mensagens enviadas chegam com prefixo "ESTA MENSAGEM FOI ENVIADA POR UMA CONTA EM TRIAL".
**Solução:** Assinar um plano pago da Z-API.

---

## 6. O QUE PRECISA SER FEITO

### 🔴 Alta prioridade

- [ ] **Assinar Z-API** para remover mensagens de trial — sem isso o agente não pode ser usado com clientes reais

### 🟡 Média prioridade

- [ ] **Blacklist de números** — lista de números que o bot deve ignorar completamente (spam, concorrentes). Armazenar em `./data/blacklist.json`. Verificar no início do webhook antes de qualquer processamento.

- [ ] **Blacklist automática** — se um número disparar o rate limit X vezes no mesmo dia, entra na blacklist automaticamente.

### 🟢 Baixa prioridade

- [ ] **Follow-up automático** — se cliente não responde em X horas após última mensagem do bot, enviar reengajamento ("Ainda posso ajudar?"). Só para sessões que chegaram à etapa de cotação de preço.

- [ ] **Detecção de mensagens repetidas** — se o cliente manda a mesma mensagem 3x seguidas, tratar como confusão e oferecer falar com atendente.

- [ ] **Feedback pós-atendimento** — após "atendimento encerrado", Fari envia automaticamente: "Como foi seu atendimento? 😊 Responda de 1 a 5."

- [ ] **Métricas básicas** — endpoint `/admin/metricas` com: atendimentos por dia, taxa de conversão (chegou ao `chamar_atendente` vs total), tempo médio de resposta.

- [ ] **Alerta de volume alto** — se mais de N atendimentos simultâneos ativos, notificar o grupo da equipe.

- [ ] **Relatório diário automático** — às 18h, enviar no grupo: X atendimentos, X leads qualificados, X convertidos.

- [ ] **Testes automatizados** — script que simula conversas completas via `POST /testar` e verifica se as ferramentas foram chamadas corretamente.

---

## 7. VARIÁVEIS DE AMBIENTE

| Variável | Status | Descrição |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ Preenchida | Chave Claude API |
| `MICROVIX_USUARIO` | ✅ Preenchida | `linx_b2c` |
| `MICROVIX_SENHA` | ✅ Preenchida | `linx_b2c` |
| `MICROVIX_CHAVE` | ✅ Preenchida | UUID do cliente |
| `MICROVIX_CNPJ` | ✅ Preenchida | CNPJ da Casa Faria |
| `MICROVIX_GRUPO` | ✅ Preenchida | `CASA FARIA COHAMA WS B2C` |
| `ZAPI_INSTANCE_URL` | ✅ Preenchida | URL da instância Z-API |
| `ZAPI_CLIENT_TOKEN` | ✅ Preenchida | Token de segurança Z-API |
| `GROQ_API_KEY` | ✅ Preenchida | Para transcrição Whisper |
| `GRUPO_EQUIPE` | ✅ Preenchida | ID do grupo "ATENDIMENTOS PENDENTES" |
| `NUMERO_EQUIPE` | ⚠️ Opcional | Número do atendente para ligação de urgência |
| `ADMIN_TOKEN` | ⚠️ Opcional | Token para proteger endpoints /admin/* |
| `AUTO_RESUME_HORAS` | ✅ `4` | Horas para bot retomar automaticamente |
| `ALERTA_SEM_ATENDIMENTO` | ✅ `30` | Minutos sem atendimento para disparar alerta |
| `SESSOES_FILE` | ✅ `/app/data/sessoes.json` | Path do arquivo de sessões (Docker) |
| `PORT` | ✅ `3000` | Porta do servidor |

---

## 8. ENDPOINTS

| Método | Path | Descrição |
|---|---|---|
| POST | `/webhook/whatsapp` | Recebe eventos da Z-API |
| POST | `/testar` | Teste sem WhatsApp: `{ mensagem, telefone }` |
| GET | `/health` | Status + contagem de sessões e filas |
| POST | `/admin/pausar/:tel` | Pausa bot para número (header: `x-admin-token`) |
| POST | `/admin/retomar/:tel` | Retoma bot para número |
| GET | `/admin/sessoes` | Lista todas as sessões ativas/pausadas |

---

## 9. COMANDOS ÚTEIS

```bash
# Subir
docker compose up -d

# Logs em tempo real
docker compose logs -f agente

# Reiniciar com novas envs
docker compose down && docker compose up -d

# Retomar bot para um número via admin
curl -X POST http://localhost:3000/admin/retomar/559881345727 \
  -H "x-admin-token: SEU_TOKEN"

# Teste direto sem WhatsApp
curl -X POST http://localhost:3000/testar \
  -H "Content-Type: application/json" \
  -d '{"mensagem": "Tem cervejeira?", "telefone": "11999999999"}'

# Verificar saúde
curl http://localhost:3000/health

# Túnel ngrok (para webhook em desenvolvimento)
npx ngrok http 3000
```

---

## 10. DECISÕES TÉCNICAS IMPORTANTES

### Por que Z-API em vez de Evolution API?
Evolution API v2.2.3 (latest stable) não consegue enviar mensagens para JIDs no formato `@lid` (novos IDs internos do WhatsApp). Retorna 400 ao tentar enviar. Z-API resolve LIDs internamente no servidor deles.

### Por que single-file (server.js)?
Decisão de design inicial. Toda a lógica em um arquivo facilita deploy e entendimento, mas começa a ficar longo (~1300 linhas). Candidato a refatoração se o projeto crescer muito.

### Por que Groq para áudio e não Whisper direto?
Groq oferece Whisper large-v3-turbo com latência muito menor que a API da OpenAI. Custo similar ou menor. Transcrição em pt-BR funciona bem.

### Por que cache de 10min para o catálogo Microvix?
O endpoint `B2CConsultaProdutos` retorna o catálogo inteiro (potencialmente centenas de produtos). Buscar a cada mensagem seria lento e caro. 10min é tempo suficiente para absorver picos de atendimento sem perder atualizações de estoque urgentes.

### Por que remover imagens do histórico após resposta?
Imagens em base64 são muito grandes. Manter no histórico triplicaria o tamanho de cada chamada à API Anthropic nas mensagens subsequentes. Após a resposta, a imagem é substituída por `[imagem] [legenda]` no histórico.

### Por que o horário de funcionamento é injetado no prompt e não bloqueia no código?
Decisão de 2026-03-21: bloquear no código desperdiça leads fora do horário. A Fari atende normalmente fora do expediente, informa o horário, e passa leads qualificados para o atendente com a data/hora de retorno calculada dinamicamente. O atendente humano só responde no próximo dia útil.

### Por que rate limit de 15 chamadas/hora?
Um atendimento completo raramente passa de 10 iterações. 15 é generoso para qualquer conversa real e protege contra spam e custo descontrolado. Ao atingir o limite, o cliente é passado para um atendente em vez de ser ignorado silenciosamente.

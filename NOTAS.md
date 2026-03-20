# Notas do Projeto — Agente IA Casa Faria Cohama

> Arquivo de anotações técnicas para uso interno (Claude Code).
> Atualizado em: 2026-03-20

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
    ├── debounce (1500ms) — agrupa mensagens rápidas
    ├── fila por telefone — evita condição de corrida
    ├── anti-ban (leitura + jitter + tempo mínimo)
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
- [x] Sessão marcada `pausado: true` + `pausadoEm: timestamp`
- [x] Retomada automática por tempo (`AUTO_RESUME_HORAS`, padrão: 4h)
- [x] Retomada via palavra-chave no fromMe: texto contendo "atendimento encerrado"
- [x] Retomada via comando da equipe: atendente envia "retomar XXXXXXXXXX" no WhatsApp
- [x] Retomada via endpoint admin: `POST /admin/retomar/:telefone`
- [x] Timer de vigilância (`setInterval` a cada 1min) — após `ALERTA_SEM_ATENDIMENTO` minutos (padrão: 30min) sem atendimento: envia desculpas ao cliente, alerta urgente no grupo, liga para `NUMERO_EQUIPE`

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

---

## 4. BUGS CONHECIDOS / PROBLEMAS PENDENTES

### 🔴 CRÍTICO — chamar_atendente não está sendo chamado como tool_use

**Sintoma:** Claude escreve a mensagem de handoff em texto ("Vou chamar um atendente...") sem executar a ferramenta `chamar_atendente`. O bot não pausa, o grupo não é notificado, nenhum atendente sabe do pedido.

**Causa raiz:** Claude está fazendo `end_turn` com texto descritivo em vez de `tool_use`. É um problema de alinhamento do prompt — o modelo interpreta a instrução como informação a comunicar ao cliente, não como gatilho obrigatório de ferramenta.

**O que já foi tentado:**
1. Adicionado "USE IMEDIATAMENTE a ferramenta chamar_atendente" no prompt
2. Adicionado "REGRA ABSOLUTA: nunca escreva sem chamar a ferramenta"
3. Adicionado "CRÍTICO — COMPORTAMENTO PROIBIDO" com exemplos explícitos do que não fazer
4. Adicionado "NUNCA inclua o resumo para o atendente no texto ao cliente"

**Nenhuma das tentativas resolveu ainda.**

**Próximos passos para investigar:**
- Opção A: Usar `tool_choice: { type: "auto" }` explícito + reformular o prompt como condição imperativa mais simples ("Se cliente confirmou X, Y, Z → use chamar_atendente")
- Opção B: Remover o step-by-step numérico do prompt e substituir por uma regra condicional clara: "Quando [condição] → chamar_atendente. Ponto."
- Opção C: Detectar no código quando Claude menciona "atendente" ou "PIX" no texto sem ter chamado a ferramenta, e forçar nova iteração com mensagem de sistema instruindo a usar a ferramenta
- Opção D: Adicionar `tool_choice: { type: "required" }` apenas quando a sessão estiver em estado "aguardando fechamento" (requer detecção de estado no código)

**Recomendação:** Tentar Opção B primeiro (prompt mais simples e direto), depois Opção C (detecção no código como fallback).

### 🟡 MÉDIO — Conta Z-API em trial

**Sintoma:** Todas as mensagens enviadas chegam com prefixo "ESTA MENSAGEM FOI ENVIADA POR UMA CONTA EM TRIAL". Impossível distinguir se o bot está funcionando corretamente em produção real.

**Solução:** Assinar um plano pago da Z-API. Sem isso, o agente não pode ser usado com clientes reais.

---

## 5. O QUE PRECISA SER FEITO

### 🔴 Alta prioridade

- [ ] **Resolver bug do chamar_atendente** (ver seção 4 acima)
- [ ] **Assinar Z-API** para remover mensagens de trial

### 🟡 Média prioridade

- [ ] **Horário de funcionamento no código** — atualmente só no prompt. O código deveria verificar o horário e rejeitar mensagens fora do expediente com resposta automática, sem gastar tokens da API Anthropic. Horário: Seg-Sex 8h–18h, Sáb 8h–16h. Considerar timezone `America/Sao_Paulo`.

- [ ] **Rate limiting por número** — evitar que um único número consuma tokens excessivos (ex: máximo de N chamadas à API por hora por telefone). Protege contra abuso e custo descontrolado.

### 🟢 Baixa prioridade

- [ ] **Follow-up automático** — se cliente não responde em X horas após última mensagem do bot, enviar uma mensagem de reengajamento (ex: "Ainda posso ajudar com algo?"). Cuidado: pode irritar se mal calibrado. Sugestão: só para sessões que chegaram à etapa de cotação de preço.

- [ ] **Blacklist de números** — lista de números que o bot deve ignorar completamente (ex: números de spam, concorrentes). Armazenar em `./data/blacklist.json`.

- [ ] **Métricas básicas** — contador de atendimentos por dia, taxa de conversão (chegou ao chamar_atendente vs total), tempo médio de resposta. Pode ser um endpoint `/admin/metricas` ou simplesmente log estruturado.

- [ ] **Testes automatizados** — script que simula conversas completas via `POST /testar` e verifica se as ferramentas foram chamadas corretamente. Essencial para validar mudanças no prompt sem precisar testar manualmente no WhatsApp.

---

## 6. VARIÁVEIS DE AMBIENTE

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

## 7. ENDPOINTS

| Método | Path | Descrição |
|---|---|---|
| POST | `/webhook/whatsapp` | Recebe eventos da Z-API |
| POST | `/testar` | Teste sem WhatsApp: `{ mensagem, telefone }` |
| GET | `/health` | Status + contagem de sessões e filas |
| POST | `/admin/pausar/:tel` | Pausa bot para número (header: `x-admin-token`) |
| POST | `/admin/retomar/:tel` | Retoma bot para número |
| GET | `/admin/sessoes` | Lista todas as sessões ativas/pausadas |

---

## 8. COMANDOS ÚTEIS

```bash
# Subir
docker compose up -d

# Logs em tempo real
docker compose logs -f agente

# Reiniciar com novas envs
docker compose down && docker compose up -d

# Remover containers órfãos (Evolution API antiga)
docker compose down --remove-orphans && docker compose up -d

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

## 9. DECISÕES TÉCNICAS IMPORTANTES

### Por que Z-API em vez de Evolution API?
Evolution API v2.2.3 (latest stable) não consegue enviar mensagens para JIDs no formato `@lid` (novos IDs internos do WhatsApp). Retorna 400 ao tentar enviar. Z-API resolve LIDs internamente no servidor deles.

### Por que single-file (server.js)?
Decisão de design inicial. Toda a lógica em um arquivo facilita deploy e entendimento, mas começa a ficar longo (~1200 linhas). Candidato a refatoração se o projeto crescer muito.

### Por que Groq para áudio e não Whisper direto?
Groq oferece Whisper large-v3-turbo com latência muito menor que a API da OpenAI. Custo similar ou menor. Transcrição em pt-BR funciona bem.

### Por que cache de 10min para o catálogo Microvix?
O endpoint `B2CConsultaProdutos` retorna o catálogo inteiro (potencialmente centenas de produtos). Buscar a cada mensagem seria lento e caro. 10min é tempo suficiente para absorver picos de atendimento sem perder atualizações de estoque urgentes.

### Por que remover imagens do histórico após resposta?
Imagens em base64 são muito grandes. Manter no histórico triplicaria o tamanho de cada chamada à API Anthropic nas mensagens subsequentes. Após a resposta, a imagem é substituída por `[imagem] [legenda]` no histórico.

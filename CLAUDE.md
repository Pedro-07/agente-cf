# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install       # Install dependencies
npm start         # Run in production
npm run dev       # Run with --watch (auto-restart on file changes)
```

### Testing without WhatsApp

```bash
curl -X POST http://localhost:3000/testar \
  -H "Content-Type: application/json" \
  -d '{"mensagem": "Tem cervejeira?", "telefone": "11999999999"}'
```

Health check: `GET /health`

### Local tunnel (for webhook testing)

```bash
npx ngrok http 3000
```

## Architecture

Single-file Node.js app (`server.js`) using ES modules. All logic lives in one file with no external config or routes modules.

```
WhatsApp user
    │
    ▼
Evolution API → POST /webhook/whatsapp
    │
    ▼
server.js
    ├── executarAgente()        # Agentic loop (up to 10 iterations)
    │       ├── Claude API (tool_use / end_turn)
    │       └── Tool dispatch → Microvix API calls
    │
    ├── enviarResposta()        # Sends text + images separately
    └── simularDigitando()      # Typing presence indicator
```

**Conversation memory** is in-process only (`sessoes` Map keyed by phone number) — restarts clear all history.

**Agentic loop**: `executarAgente()` calls Claude in a loop. If `stop_reason === "tool_use"`, it executes the requested Microvix tools and pushes results back. Loops until `end_turn` or 10 iterations.

**Microvix tools** available to Claude:
- `consultar_produtos_por_nome` — search by name/category
- `consultar_estoque_por_codigo` — stock by SKU
- `consultar_preco_por_codigo` — price by SKU
- `consultar_promocao_por_codigo` — active promotions by SKU
- `consultar_imagens_por_codigo` — image URLs by SKU
- `consultar_produtos_por_referencia` — search by reference code

**LID resolution**: WhatsApp `@lid` JIDs are resolved to real `@s.whatsapp.net` numbers via `resolverLid()` before sending.

**Image sending**: URLs extracted from Claude's text response are sent as separate media messages; image URLs are stripped from the text before sending.

## Environment Variables

Required in `.env`:

```
ANTHROPIC_API_KEY=
EVOLUTION_API_URL=
EVOLUTION_API_KEY=
EVOLUTION_INSTANCE=
MICROVIX_USUARIO=
MICROVIX_SENHA=
MICROVIX_CHAVE=
MICROVIX_CNPJ=
PORT=3000
```

## Extending with new tools

1. Add a `async function consultarXxx(...)` that calls `chamarMicrovix()` and parses with `mapearColunas()`
2. Add the tool definition to the `tools` array with its `input_schema`
3. Add the `case` in `executarAgente()`'s tool dispatch switch

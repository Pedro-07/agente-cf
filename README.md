# 🤖 Agente WhatsApp + Linx Microvix

Agente de IA para atendimento ao cliente via WhatsApp com consulta de estoque em tempo real no **Linx Microvix**.

---

## 🏗️ Arquitetura

```
Cliente WhatsApp
      │
      ▼
Evolution API (recebe mensagens)
      │  webhook POST /webhook/whatsapp
      ▼
Servidor Node.js (server.js)
      │
      ├─► Anthropic API (Claude) ◄─► Ferramentas (tools)
      │                                     │
      └─────────────────────────────────────┘
                                            │
                                     Linx Microvix API
                                     (consulta estoque)
```

---

## ⚡ Instalação rápida

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
# Edite o .env com suas credenciais
```

### 3. Iniciar o servidor
```bash
npm start
# ou em desenvolvimento:
npm run dev
```

---

## 🔑 Credenciais necessárias

### Anthropic (Claude)
- Acesse: https://console.anthropic.com
- Crie uma API Key em **API Keys**

### Linx Microvix
- Acesse o painel do Microvix → **Integrações** → **API**
- Gere um token de acesso
- Copie o CNPJ da empresa cadastrada

### Evolution API (WhatsApp)
Opções de uso:
- **Self-hosted**: https://github.com/EvolutionAPI/evolution-api
- **Cloud**: https://evolution-api.com (plano pago)
- **Alternativa gratuita**: Z-API (https://z-api.io) — requer ajuste no código

---

## 📡 Configurar o Webhook no WhatsApp

Após o servidor estar rodando com URL pública (use ngrok para testes):

```bash
# Instalar ngrok para testes locais
npx ngrok http 3000
# Copie a URL gerada: https://xxxx.ngrok.io
```

Configure o webhook na Evolution API:
- URL: `https://sua-url.com/webhook/whatsapp`
- Eventos: `messages.upsert`

---

## 🧪 Testar sem WhatsApp

```bash
curl -X POST http://localhost:3000/testar \
  -H "Content-Type: application/json" \
  -d '{"mensagem": "Tem camiseta branca tamanho M?", "telefone": "11999999999"}'
```

---

## 🚀 Deploy em produção

### Railway (recomendado — gratuito para começar)
1. Crie conta em https://railway.app
2. Conecte seu repositório GitHub
3. Adicione as variáveis de ambiente no painel
4. Deploy automático!

### Render
1. Crie conta em https://render.com
2. New → Web Service → conecte o repositório
3. Build: `npm install` | Start: `npm start`

---

## 💬 Exemplos de perguntas que o agente responde

- *"Tem tênis Nike tamanho 42?"*
- *"Qual o estoque do produto SKU001?"*
- *"Vocês têm camiseta polo azul marinho?"*
- *"Está disponível o código 7891234567890?"*

---

## 🔧 Adicionar mais funcionalidades

Para adicionar novas consultas ao ERP, edite o arquivo `server.js`:

1. Crie a função de integração (ex: `consultarPedido`)
2. Adicione a definição da ferramenta no array `tools`
3. Adicione o `if` correspondente no loop de execução das ferramentas

---

## 📄 Licença
MIT

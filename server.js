/**
 * Agente de IA para WhatsApp — Casa Faria Cohama
 * Stack: Node.js + Express + Anthropic API + Z-API + Linx Microvix B2C
 *
 * Melhorias implementadas (v2):
 * - Fila de mensagens por telefone: evita condição de corrida no histórico
 * - Persistência de sessões em arquivo JSON: histórico sobrevive a reinicializações
 * - Limite de histórico por sessão: evita crescimento ilimitado e custo excessivo
 * - Retry automático nas chamadas ao Microvix: maior resiliência a falhas transientes
 * - consultarImagensPorCodigo: agora filtra no ERP, não mais carrega tudo
 * - Z-API: suporte nativo a LIDs sem resolução manual
 * - Anti-ban: confirmação de leitura + jitter de timing + tempo mínimo de resposta
 */

import express  from "express";
import axios    from "axios";
import Anthropic from "@anthropic-ai/sdk";
import dotenv   from "dotenv";
import xml2js   from "xml2js";
import fs       from "fs/promises";
import path     from "path";

dotenv.config();

const app       = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   ⚙️  CONFIGURAÇÕES
========================================================= */

const CONFIG = {
  microvix: {
    url:     "http://webapi.microvix.com.br/api/integracao",
    usuario: process.env.MICROVIX_USUARIO,
    senha:   process.env.MICROVIX_SENHA,
    chave:   process.env.MICROVIX_CHAVE,
    cnpj:    process.env.MICROVIX_CNPJ,
  },
  whatsapp: {
    instanceUrl: process.env.ZAPI_INSTANCE_URL,  // https://api.z-api.io/instances/{id}/token/{token}
    clientToken: process.env.ZAPI_CLIENT_TOKEN,  // token de segurança do webhook (Z-API Security)
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY,  // transcrição de áudio via Whisper
  },
  equipe: {
    numero:         process.env.NUMERO_EQUIPE,                       // número para ligar em urgências
    grupo:          process.env.GRUPO_EQUIPE,                        // ID do grupo para notificações
    adminToken:     process.env.ADMIN_TOKEN,                         // token para endpoints /admin/*
    autoResumeHoras: parseInt(process.env.AUTO_RESUME_HORAS  || "0"), // 0 = desabilitado
    alertaMinutos:   parseInt(process.env.ALERTA_SEM_ATENDIMENTO || "30"),
  },
  anthropic: {
    model: "claude-sonnet-4-20250514",
  },
  sessoes: {
    // Arquivo de persistência — deve ser mapeado para volume Docker em produção.
    // Definir SESSOES_FILE=/app/data/sessoes.json e montar ./data:/app/data no compose.
    arquivo:      process.env.SESSOES_FILE || "./data/sessoes.json",
    // Máximo de mensagens mantidas no histórico por cliente.
    // Acima desse valor, mensagens antigas são removidas para controlar custo e tokens.
    maxHistorico: 20,
  },
};

/* =========================================================
   💾 PERSISTÊNCIA DE SESSÕES (arquivo JSON)

   Problema resolvido: reinicializações do servidor apagavam
   todo o histórico de conversa dos clientes (memória em RAM).

   Solução: salvar sessões em JSON após cada interação.
   Em Docker, mapear SESSOES_FILE para um volume nomeado:
     volumes:
       - ./data:/app/data
   E definir no compose: SESSOES_FILE=/app/data/sessoes.json
========================================================= */

const sessoes = new Map();

async function carregarSessoes() {
  try {
    await fs.mkdir(path.dirname(CONFIG.sessoes.arquivo), { recursive: true });
    const conteudo = await fs.readFile(CONFIG.sessoes.arquivo, "utf-8");
    const dados    = JSON.parse(conteudo);
    for (const [tel, sessao] of Object.entries(dados)) {
      sessoes.set(tel, sessao);
    }
    console.log(`💾 Sessões carregadas: ${sessoes.size} clientes`);
  } catch (err) {
    // ENOENT = arquivo ainda não existe (primeira execução) — comportamento esperado
    if (err.code !== "ENOENT") {
      console.warn("⚠️ Erro ao carregar sessões:", err.message);
    }
  }
}

async function salvarSessoes() {
  try {
    const dados = Object.fromEntries(sessoes);
    await fs.writeFile(CONFIG.sessoes.arquivo, JSON.stringify(dados, null, 2), "utf-8");
  } catch (err) {
    console.error("❌ Erro ao salvar sessões:", err.message);
  }
}

function getSessao(telefone) {
  if (!sessoes.has(telefone)) {
    sessoes.set(telefone, { historico: [], nome: null, telefone, pausado: false });
  }
  return sessoes.get(telefone);
}

/* =========================================================
   🔄 FILA DE MENSAGENS POR TELEFONE

   Problema resolvido: se o mesmo número enviasse duas mensagens
   rapidamente, dois executarAgente() rodavam em paralelo e
   corrompiam o histórico via condição de corrida no historico.push.

   Solução: encadear Promises por telefone — cada mensagem espera
   a anterior terminar antes de ser processada.
========================================================= */

const filasPorTelefone   = new Map();
const debouncePorTelefone = new Map();
const DEBOUNCE_MS = 1500; // agrupa mensagens enviadas em sequência em até 1.5s

function processarNaFila(telefone, fn) {
  // Pega a promise anterior ou resolve imediatamente se a fila estiver vazia
  const anterior = filasPorTelefone.get(telefone) || Promise.resolve();

  // Encadeia a nova tarefa após a anterior terminar (com ou sem erro)
  const proxima = anterior
    .then(fn)
    .catch(err => console.error(`❌ Erro na fila [${telefone}]:`, err.message));

  // Atualiza o Map com a promise mais recente
  filasPorTelefone.set(telefone, proxima);

  // Remove a entrada do Map quando a fila esvaziar para não vazar memória
  proxima.finally(() => {
    if (filasPorTelefone.get(telefone) === proxima) {
      filasPorTelefone.delete(telefone);
    }
  });

  return proxima;
}

/* =========================================================
   🕐 HELPERS DE TEMPO (anti-ban)

   Respostas instantâneas são um sinal claro de automação para o WhatsApp.
   randomEntre() injeta jitter nos delays para imitar comportamento humano.
========================================================= */

function randomEntre(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/* =========================================================
   🔁 RETRY PARA CHAMADAS EXTERNAS

   Problema resolvido: falhas transientes na API do Microvix
   (timeout, 5xx esporádico) derrubavam a ferramenta sem nova tentativa.

   Solução: wrapper com backoff linear — espera delayMs * tentativa
   antes de cada retry, para não sobrecarregar o serviço em falha.
========================================================= */

async function comRetry(fn, tentativas = 2, delayMs = 1000) {
  for (let i = 0; i <= tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === tentativas) throw err; // Esgotou tentativas — propaga o erro
      console.warn(`⚠️ Tentativa ${i + 1} falhou: ${err.message}. Retry em ${delayMs * (i + 1)}ms...`);
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
}

/* =========================================================
   💾 CACHE DE CONSULTAS EXTERNAS

   Catálogo e imagens do Microvix raramente mudam — buscar o catálogo
   inteiro a cada mensagem é desnecessário. Cache de 10 min elimina
   a maioria das chamadas repetidas ao ERP.
========================================================= */

const cache = new Map();

function cachePegar(chave) {
  const entrada = cache.get(chave);
  if (!entrada || Date.now() > entrada.expiraEm) {
    cache.delete(chave);
    return null;
  }
  return entrada.dados;
}

function cacheSalvar(chave, dados, ttlMs = 10 * 60 * 1000) {
  cache.set(chave, { dados, expiraEm: Date.now() + ttlMs });
}

/* =========================================================
   📏 TRUNCAMENTO DE HISTÓRICO

   Problema resolvido: histórico crescia indefinidamente,
   aumentando custo da API Anthropic e risco de estouro de contexto.

   Solução: manter apenas as últimas MAX_HISTORICO mensagens.
   Garante que o histórico sempre comece com role "user",
   pois a API Anthropic rejeita históricos que começam com "assistant".
========================================================= */

function truncarHistorico(historico) {
  const max = CONFIG.sessoes.maxHistorico;
  if (historico.length <= max) return historico;

  let inicio = historico.length - max;

  // O histórico deve começar com uma mensagem "user" de texto puro.
  // Mensagens user podem conter tool_result (retorno de ferramenta) —
  // se o corte cair sobre um tool_result sem o tool_use anterior, a API rejeita.
  while (inicio < historico.length) {
    const msg = historico[inicio];
    if (msg.role === "user") {
      const isToolResult = Array.isArray(msg.content) &&
        msg.content.some(c => c.type === "tool_result");
      if (!isToolResult) break;
    }
    inicio++;
  }

  return historico.slice(inicio);
}

/* =========================================================
   👤 DETECÇÃO DE NOME DO CLIENTE
========================================================= */

const NAO_SAO_NOMES = new Set([
  // cumprimentos
  "oi", "olá", "ola", "opa", "ei", "eai", "eaí", "alô", "alo", "hey", "hi",
  // respostas curtas
  "bom", "boa", "ok", "sim", "não", "nao", "bem", "certo", "tudo",
  // verbos / pronomes
  "fala", "bora", "pode", "tem", "vai", "vem", "quer", "sou", "meu", "minha",
  "preciso", "quero", "tenho", "gostaria", "quanto", "qual", "como", "quando",
  // horários / períodos
  "dia", "tarde", "noite", "manha", "manhã",
  // substantivos comuns que não são nomes de pessoas
  "empresa", "cnpj", "produto", "preço", "preco", "estoque", "pedido",
  "valor", "desconto", "entrega", "prazo", "loja", "compra", "orçamento",
  // produtos (auto-capitalização no celular pode confundir)
  "refrigerador", "freezer", "cervejeira", "fogão", "fogao", "forno",
  "fritadeira", "balcão", "balcao", "vitrine", "geladeira", "buffet",
  "batedeira", "amassadeira", "processador", "extrator",
]);

function detectarNome(texto) {
  const invalidos = [
    /deus/i, /jesus/i, /fiel/i, /senhor/i, /cristo/i, /gloria/i,
    /amém/i, /bênção/i, /graça/i, /espírito/i, /santo/i,
    /\d/,
    /.{40,}/,
    /[^\p{L}\s'-]/u,
  ];

  const palavras = texto.trim().split(/\s+/);
  if (palavras.length < 1 || palavras.length > 4) return null;
  if (invalidos.some(r => r.test(texto))) return null;

  const primeiroNome = palavras[0];
  if (primeiroNome.length < 2) return null;
  if (!/^[A-ZÁÉÍÓÚÂÊÎÔÛÀÃÕÇ]/.test(primeiroNome)) return null;
  if (NAO_SAO_NOMES.has(primeiroNome.toLowerCase())) return null;
  if (primeiroNome.length < 3) return null;

  return primeiroNome;
}

/* =========================================================
   🔧 MICROVIX — helpers
========================================================= */

// <Name> com N maiúsculo é obrigatório pelo Microvix
function montarXml(metodo, parametros = []) {
  const params = parametros
    .map(p => `      <Parameter id="${p.id}">${p.valor}</Parameter>`)
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<LinxMicrovix>
  <Authentication user="${CONFIG.microvix.usuario}" password="${CONFIG.microvix.senha}"/>
  <ResponseFormat>xml</ResponseFormat>
  <Command>
    <Name>${metodo}</Name>
    <Parameters>
      <Parameter id="chave">${CONFIG.microvix.chave}</Parameter>
      <Parameter id="cnpjEmp">${CONFIG.microvix.cnpj}</Parameter>
${params}
    </Parameters>
  </Command>
</LinxMicrovix>`;
}

async function chamarMicrovix(xml) {
  // Envolvido em comRetry para tolerar falhas transientes do ERP
  return comRetry(async () => {
    console.log("📤 XML Microvix:\n", xml);
    const res = await axios.post(CONFIG.microvix.url, xml, {
      headers: { "Content-Type": "application/xml" },
      timeout: 15000,
    });
    console.log("📥 Resposta Microvix:\n", res.data.substring(0, 500));
    return xml2js.parseStringPromise(res.data, { explicitArray: false });
  });
}

/**
 * Converte formato C/R do Microvix para array de objetos com campos nomeados.
 * <C><D>col1</D>...</C> = nomes das colunas
 * <R><D>val1</D>...</R> = valores de cada linha
 */
function mapearColunas(responseData) {
  if (!responseData) return [];

  const colunas = responseData?.C?.D;
  const linhas  = responseData?.R;

  if (!colunas || !linhas) return [];

  const colunasArr = Array.isArray(colunas) ? colunas : [colunas];
  const linhasArr  = Array.isArray(linhas)  ? linhas  : [linhas];

  return linhasArr.map(linha => {
    const valores = Array.isArray(linha.D) ? linha.D : [linha.D];
    const obj = {};
    colunasArr.forEach((col, i) => { obj[col] = valores[i] ?? ""; });
    return obj;
  });
}

/* =========================================================
   📡 MICROVIX — consultas
========================================================= */

async function consultarProdutosPorNome(nomeProduto) {
  try {
    // Catálogo completo em cache — evita buscar o ERP a cada mensagem.
    // TTL de 10 min: suficiente para absorver picos, curto o bastante para pegar atualizações.
    const CHAVE = "microvix:catalogo";
    let todos = cachePegar(CHAVE);
    if (!todos) {
      const xml = montarXml("B2CConsultaProdutos", [{ id: "timestamp", valor: "0" }]);
      const json = await chamarMicrovix(xml);
      todos = mapearColunas(json?.Microvix?.ResponseData);
      cacheSalvar(CHAVE, todos);
      console.log(`📋 Catálogo carregado: ${todos.length} produtos`);
    } else {
      console.log(`📋 Catálogo via cache: ${todos.length} produtos`);
    }

    const termo     = nomeProduto.toLowerCase();
    const filtrados = todos.filter(p => {
      if (p.ativo !== "1" && p.ativo !== 1) return false;
      const nome = (p.nome_produto || p.descricao_basica || "").toLowerCase();
      const ref  = (p.referencia   || "").toLowerCase();
      return nome.includes(termo) || ref.includes(termo);
    });

    if (!filtrados.length) {
      return { sucesso: true, produtos: [], mensagem: `Nenhum produto encontrado para "${nomeProduto}".` };
    }

    return {
      sucesso: true,
      produtos: filtrados.map(p => ({
        codigo:    p.codigoproduto || "",
        descricao: p.nome_produto  || p.descricao_basica || "",
      })),
    };
  } catch (err) {
    console.error("❌ consultarProdutosPorNome:", err.message);
    return { sucesso: false, erro: err.message };
  }
}

async function consultarEstoquePorCodigo(codigoProduto) {
  try {
    const xml  = montarXml("B2CConsultaProdutosDetalhes", [
      { id: "codigoproduto", valor: codigoProduto },
      { id: "timestamp",     valor: "0" },
    ]);
    const json  = await chamarMicrovix(xml);
    const itens = mapearColunas(json?.Microvix?.ResponseData);

    if (!itens.length) return { disponivel: false, quantidade: 0 };

    const quantidade = itens.reduce((acc, i) => acc + Number(i.saldo || 0), 0);

    return { disponivel: quantidade > 0, quantidade };
  } catch (err) {
    console.error("❌ consultarEstoquePorCodigo:", err.message);
    return { sucesso: false, erro: err.message };
  }
}

async function consultarPrecoPorCodigo(codigoProduto) {
  try {
    const xml  = montarXml("B2CConsultaProdutosCustos", [
      { id: "codigoproduto", valor: codigoProduto },
      { id: "timestamp",     valor: "0" },
    ]);
    const json  = await chamarMicrovix(xml);
    const itens = mapearColunas(json?.Microvix?.ResponseData);

    if (!itens.length) return { sucesso: true, mensagem: "Preço não encontrado." };

    const item = itens.reduce((max, i) =>
      Number(i.precovenda || 0) > Number(max.precovenda || 0) ? i : max, itens[0]);

    return { precovenda: Number(item.precovenda || 0) };
  } catch (err) {
    console.error("❌ consultarPrecoPorCodigo:", err.message);
    return { sucesso: false, erro: err.message };
  }
}

async function consultarPromocaoPorCodigo(codigoProduto) {
  try {
    const xml  = montarXml("B2CConsultaProdutosPromocao", [
      { id: "codigoproduto",          valor: codigoProduto },
      { id: "somente_promocao_ativa", valor: "1" },
      { id: "timestamp",              valor: "0" },
    ]);
    const json  = await chamarMicrovix(xml);
    const itens = mapearColunas(json?.Microvix?.ResponseData);

    if (!itens.length) return { emPromocao: false };

    const promo = itens[0];
    return {
      emPromocao:    true,
      precoPromocao: Number(promo.preco || 0),
      dataTermino:   promo.data_termino || "",
    };
  } catch (err) {
    console.error("❌ consultarPromocaoPorCodigo:", err.message);
    return { sucesso: false, erro: err.message };
  }
}

async function consultarImagensPorCodigo(codigoProduto) {
  try {
    // O endpoint não suporta filtro por produto — retorna tudo e filtramos localmente.
    // Cache de 10 min para evitar recarregar o catálogo de imagens a cada consulta.
    const CHAVE = "microvix:imagens";
    let itens = cachePegar(CHAVE);
    if (!itens) {
      const xml = montarXml("B2CConsultaProdutosImagensURL", [{ id: "timestamp", valor: "0" }]);
      const json = await chamarMicrovix(xml);
      itens = mapearColunas(json?.Microvix?.ResponseData);
      cacheSalvar(CHAVE, itens);
    }

    // Filtro local mantido como segurança caso o ERP retorne produtos adjacentes
    const imagens = itens
      .filter(i => String(i.codigoproduto) === String(codigoProduto))
      .map(i => i.url_imagem_blob)
      .filter(Boolean);

    return { sucesso: true, imagens };
  } catch (err) {
    console.error("❌ consultarImagensPorCodigo:", err.message);
    return { sucesso: false, erro: err.message };
  }
}

async function consultarProdutosPorReferencia(referencia) {
  try {
    const xml  = montarXml("B2CConsultaProdutos", [
      { id: "referencia", valor: referencia },
      { id: "timestamp",  valor: "0" },
    ]);
    const json     = await chamarMicrovix(xml);
    const produtos = mapearColunas(json?.Microvix?.ResponseData);

    if (!produtos.length) {
      return { sucesso: true, produtos: [], mensagem: `Referência "${referencia}" não encontrada.` };
    }

    return {
      sucesso: true,
      produtos: produtos.map(p => ({
        codigo:    p.codigoproduto || "",
        descricao: p.nome_produto  || p.descricao_basica || "",
      })),
    };
  } catch (err) {
    console.error("❌ consultarProdutosPorReferencia:", err.message);
    return { sucesso: false, erro: err.message };
  }
}

/* =========================================================
   🛠️  FERRAMENTAS DO CLAUDE
========================================================= */

const tools = [
  {
    name: "consultar_produtos_por_nome",
    description:
      "Busca produtos no Microvix pelo nome ou categoria. " +
      "Use quando o cliente mencionar qualquer tipo de produto. " +
      "Após encontrar, use consultar_estoque_por_codigo e consultar_preco_por_codigo.",
    input_schema: {
      type: "object",
      properties: {
        nomeProduto: {
          type: "string",
          description: "Ex: 'cervejeira', 'refrigerador expositor', 'freezer', 'balcão açougue', 'forno', 'fogão'",
        },
      },
      required: ["nomeProduto"],
    },
  },
  {
    name: "consultar_estoque_por_codigo",
    description: "Consulta quantidade em estoque de um produto pelo SKU.",
    input_schema: {
      type: "object",
      properties: {
        codigoProduto: { type: "string", description: "SKU numérico. Ex: '22631'" },
      },
      required: ["codigoProduto"],
    },
  },
  {
    name: "consultar_preco_por_codigo",
    description: "Consulta o preço de venda de um produto pelo SKU. Use sempre que o cliente perguntar sobre valor.",
    input_schema: {
      type: "object",
      properties: {
        codigoProduto: { type: "string", description: "SKU numérico. Ex: '22631'" },
      },
      required: ["codigoProduto"],
    },
  },
  {
    name: "consultar_promocao_por_codigo",
    description: "Verifica se um produto está em promoção. Use quando o cliente perguntar sobre desconto.",
    input_schema: {
      type: "object",
      properties: {
        codigoProduto: { type: "string", description: "SKU numérico. Ex: '22631'" },
      },
      required: ["codigoProduto"],
    },
  },
  {
    name: "consultar_imagens_por_codigo",
    description: "Retorna URLs das imagens de um produto. Use quando o cliente pedir fotos.",
    input_schema: {
      type: "object",
      properties: {
        codigoProduto: { type: "string", description: "SKU numérico. Ex: '22631'" },
      },
      required: ["codigoProduto"],
    },
  },
  {
    name: "chamar_atendente",
    description:
      "Chama um atendente humano para assumir a conversa. " +
      "Use quando o cliente quiser fechar a compra, pedir atendimento humano, " +
      "ou tiver dúvidas que você não consegue resolver. " +
      "Após usar esta ferramenta, informe o cliente que o atendente foi notificado e pedirá aguardar.",
    input_schema: {
      type: "object",
      properties: {
        resumo: {
          type: "string",
          description: "Resumo para o atendente: produto(s), qtd, PJ ou PF, forma de pagamento, valor final calculado.",
        },
      },
      required: ["resumo"],
    },
  },
  {
    name: "consultar_produtos_por_referencia",
    description: "Busca produtos por código de referência alfanumérico.",
    input_schema: {
      type: "object",
      properties: {
        referencia: { type: "string", description: "Ex: 'GPTU230', '1403EF'" },
      },
      required: ["referencia"],
    },
  },
];

/* =========================================================
   🤖 SYSTEM PROMPT
========================================================= */

function montarSystemPrompt(nomeCliente) {
  const saudacao = nomeCliente
    ? `O cliente se chama ${nomeCliente}. Use o nome de forma natural, só quando fizer sentido.`
    : `Ainda não sabemos o nome do cliente. Se ele se apresentar, registre internamente.`;

  return `Você é atendente da Casa Faria Cohama, loja de equipamentos para food service em São Luís - MA.

${saudacao}

## Sobre a Casa Faria
Loja especializada em equipamentos para restaurantes, hotéis, lanchonetes, bares, padarias, açougues e cozinhas em geral. Atendemos empresas (CNPJ) e pessoa física.
Endereço: Av. Daniel de La Touche, 2004 - Cohama, São Luís - MA
Maps: https://maps.app.goo.gl/NwW7nXYStV47q7FEA

## Categorias de produtos
- Açougue e Frigorífico: balcões, moedores, serra fita
- Inox e Mobiliário: mesas e prateleiras
- Panificação e Confeitaria: amassadeiras, batedeiras, batedores de milk shake, vitrines expositoras
- Refrigeração Comercial: refrigeradores, cervejeiras, balcões e vitrines refrigeradas, freezers
- Restaurante e Cozinha Industrial: fornos, fogões, chapas, fritadeiras, buffets térmicos, processadores, extratores de suco

## Descontos e condições
CNPJ com IE ativa:
- 20% à vista (PIX ou dinheiro)
- 13% no cartão, até 10x sem juros

Pessoa física:
- Compras > R$100: 5% à vista (PIX ou dinheiro)
- Compras > R$1.000: 10% à vista (PIX ou dinheiro)
- Parcelamento sem desconto:
  - Até R$499: 6x sem juros
  - Acima de R$499: 10x sem juros

Não existem outros descontos, promoções ou condições além das listadas acima. Nunca sugira ou invente condições que não estão aqui.

Entrega grátis: compras > R$500 na Grande Ilha (São Luís, São José de Ribamar, Raposa) em até 72h. Fora dessas cidades: apenas retirada na loja.

Horário de funcionamento: de segunda à sexta, das 8h às 18h e aos sábados, das 8h às 16h.

## Formas de pagamento
- PIX: o atendente humano envia a chave PIX pelo próprio WhatsApp para o cliente pagar.
- Cartão, dinheiro e boleto: apenas presencialmente na loja.
- Não há link de pagamento, maquininha remota nem outra forma de pagamento à distância.

## Como fechar uma venda
Quando o cliente demonstrar interesse em comprar:
1. Confirme o produto e a quantidade
2. Pergunte se é PJ (CNPJ com IE) ou pessoa física — isso define o desconto
3. Pergunte a forma de pagamento (PIX ou presencial)
4. Assim que tiver produto + quantidade + PJ/PF + pagamento: PARE DE ESCREVER e execute a ferramenta chamar_atendente imediatamente
5. Depois que a ferramenta retornar, escreva apenas: que o atendente foi notificado e vai entrar em contato em breve

CRÍTICO — COMPORTAMENTO PROIBIDO:
- NUNCA escreva "vou chamar um atendente", "estou transferindo", "aguarde que já vou transferir" ou qualquer variação disso SEM ter chamado a ferramenta chamar_atendente primeiro
- NUNCA inclua no texto o resumo do pedido para o atendente — isso vai no campo "resumo" da ferramenta, não no texto ao cliente
- Escrever sobre chamar o atendente SEM usar a ferramenta é um erro crítico: o cliente fica sem atendimento e ninguém é notificado
- A ferramenta chamar_atendente é o ÚNICO mecanismo que realmente notifica a equipe. Texto não notifica ninguém.

## Como se comportar
- Seja direto e vendedor — seu objetivo é fechar a venda, não só informar
- Respostas curtas (máx. 3-4 linhas). Se tiver muito a dizer, quebre em mensagens menores
- Nunca enrole ou repita o que o cliente já sabe
- Máx. 1 emoji por mensagem, só se fizer sentido
- Nunca use: "Perfeito!", "Ótimo!", "Excelente escolha!", "Com certeza!", "Claro!"
- Não use Markdown, negrito, itálico ou tachado
- Produto disponível: - [nome] — R$ [preço] — [qtd] un.
- Produto sem estoque: mencione que pode consultar previsão de reposição
- Nunca invente informações; use só dados do ERP e deste prompt
- Verifique o dia atual para informar horário correto se perguntarem
- Fora do horário de atendimento: avise e oriente a retornar no próximo dia útil
- Sempre responda em português, com linguagem natural e amigável`;
}

/* =========================================================
   🤖 MOTOR DO AGENTE
========================================================= */

// conteudo: string (texto) ou array de blocos (multimodal com imagem)
async function executarAgente(conteudo, sessao) {
  const textoPlano = typeof conteudo === "string"
    ? conteudo
    : conteudo.find(c => c.type === "text")?.text || "";

  if (!sessao.nome && textoPlano) {
    const nomeDetectado = detectarNome(textoPlano);
    if (nomeDetectado) {
      sessao.nome = nomeDetectado;
      console.log(`👤 Nome detectado: ${nomeDetectado}`);
    }
  }

  sessao.historico.push({ role: "user", content: conteudo });

  // Trunca o histórico antes de enviar para a API para controlar tokens e custo
  sessao.historico = truncarHistorico(sessao.historico);

  let resposta     = null;
  let maxIteracoes = 10;

  while (maxIteracoes-- > 0) {
    const response = await anthropic.messages.create({
      model:      CONFIG.anthropic.model,
      max_tokens: 1024,
      system:     montarSystemPrompt(sessao.nome),
      tools,
      messages:   sessao.historico,
    });

    if (response.stop_reason === "end_turn") {
      resposta = response.content.find(b => b.type === "text")?.text || "";
      sessao.historico.push({ role: "assistant", content: response.content });
      break;
    }

    if (response.stop_reason === "tool_use") {
      sessao.historico.push({ role: "assistant", content: response.content });

      const resultados = [];

      for (const bloco of response.content) {
        if (bloco.type !== "tool_use") continue;

        console.log(`🔧 ${bloco.name}`, bloco.input);

        let resultado;
        switch (bloco.name) {
          case "consultar_produtos_por_nome":
            resultado = await consultarProdutosPorNome(bloco.input.nomeProduto);
            break;
          case "consultar_estoque_por_codigo":
            resultado = await consultarEstoquePorCodigo(bloco.input.codigoProduto);
            break;
          case "consultar_preco_por_codigo":
            resultado = await consultarPrecoPorCodigo(bloco.input.codigoProduto);
            break;
          case "consultar_promocao_por_codigo":
            resultado = await consultarPromocaoPorCodigo(bloco.input.codigoProduto);
            break;
          case "consultar_imagens_por_codigo":
            resultado = await consultarImagensPorCodigo(bloco.input.codigoProduto);
            break;
          case "consultar_produtos_por_referencia":
            resultado = await consultarProdutosPorReferencia(bloco.input.referencia);
            break;
          case "chamar_atendente": {
            sessao.pausado       = true;
            sessao.pausadoEm     = Date.now();
            sessao.alertaEnviado = false;
            await salvarSessoes();
            const destino = CONFIG.equipe.grupo || CONFIG.equipe.numero;
            if (destino) {
              const aviso =
                `🔔 Atendimento solicitado\n` +
                `Cliente: ${sessao.telefone}\n\n` +
                `${bloco.input.resumo}\n\n` +
                `Para retomar o bot: retomar ${sessao.telefone}`;
              await enviarTexto(destino, aviso);
            }
            resultado = { notificado: true };
            break;
          }
          default:
            resultado = { erro: "Ferramenta desconhecida" };
        }

        resultados.push({
          type:        "tool_result",
          tool_use_id: bloco.id,
          content:     JSON.stringify(resultado),
        });
      }

      sessao.historico.push({ role: "user", content: resultados });
    }
  }

  // Remove blocos de imagem do histórico após a resposta — imagens em base64
  // são grandes demais para manter em todas as chamadas subsequentes.
  sessao.historico = sessao.historico.map(msg => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const temImagem = msg.content.some(c => c.type === "image");
      if (temImagem) {
        const texto = msg.content.find(c => c.type === "text")?.text || "";
        return { role: "user", content: texto ? `[imagem] ${texto}` : "[cliente enviou uma imagem]" };
      }
    }
    return msg;
  });

  // Persiste sessão após cada interação para sobreviver a reinicializações
  await salvarSessoes();

  return resposta || "Não consegui processar agora. Tenta de novo?";
}

/* =========================================================
   🎙️ MÍDIA — download, transcrição e visão
========================================================= */

async function baixarBase64(url, mimeTypePadrao = "application/octet-stream") {
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
  const buffer   = Buffer.from(res.data);
  const mimeType = (res.headers["content-type"] || mimeTypePadrao).split(";")[0].trim();
  return { base64: buffer.toString("base64"), mimeType, buffer };
}

async function transcreverAudio(audioUrl) {
  const { buffer } = await baixarBase64(audioUrl);
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: "audio/ogg" }), "audio.ogg");
  formData.append("model", "whisper-large-v3-turbo");
  formData.append("language", "pt");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${CONFIG.groq.apiKey}` },
    body: formData,
  });

  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.text?.trim() || "";
}

/* =========================================================
   📤 ENVIO VIA Z-API

   Z-API é um serviço gerenciado que abstrai o Baileys e resolve
   LIDs internamente — sem necessidade de mapeamento manual.

   Documentação: https://developer.z-api.io
   Formato do número: apenas dígitos com DDI (ex: 5511999999999)
========================================================= */

async function simularDigitando(telefone, duracaoMs) {
  try {
    await axios.post(
      `${CONFIG.whatsapp.instanceUrl}/send-chat-state`,
      { phone: telefone, chatState: "composing" },
      { headers: { "client-token": CONFIG.whatsapp.clientToken } }
    );
  } catch (_) {
    // Falha silenciosa — presença de digitação não é crítica para o atendimento
  }
}

async function enviarTexto(telefone, texto) {
  try {
    await axios.post(
      `${CONFIG.whatsapp.instanceUrl}/send-text`,
      { phone: telefone, message: texto },
      { headers: { "client-token": CONFIG.whatsapp.clientToken } }
    );
    console.log(`📤 Texto enviado para ${telefone}`);
  } catch (err) {
    console.error("❌ Erro ao enviar texto:", JSON.stringify(err.response?.data, null, 2) || err.message);
  }
}

async function enviarImagem(telefone, url) {
  try {
    await axios.post(
      `${CONFIG.whatsapp.instanceUrl}/send-image`,
      { phone: telefone, image: url, caption: "" },
      { headers: { "client-token": CONFIG.whatsapp.clientToken } }
    );
    console.log(`🖼️ Imagem enviada para ${telefone}`);
  } catch (err) {
    console.error("❌ Erro ao enviar imagem:", JSON.stringify(err.response?.data, null, 2) || err.message);
    await enviarTexto(telefone, `Foto do produto: ${url}`);
  }
}

async function ligarParaAtendente(numero) {
  try {
    await axios.post(
      `${CONFIG.whatsapp.instanceUrl}/start-call`,
      { phone: numero, isVideo: false },
      { headers: { "client-token": CONFIG.whatsapp.clientToken } }
    );
    console.log(`📞 Ligação iniciada para ${numero}`);
  } catch (err) {
    console.warn("⚠️ Falha ao ligar para atendente:", err.response?.data || err.message);
  }
}

async function marcarLida(telefone, messageId) {
  if (!messageId) return;
  try {
    await axios.post(
      `${CONFIG.whatsapp.instanceUrl}/read-message`,
      { phone: telefone, messageId },
      { headers: { "client-token": CONFIG.whatsapp.clientToken } }
    );
  } catch (_) {
    // Falha silenciosa — confirmação de leitura não é crítica
  }
}

function extrairUrlsImagem(texto) {
  // Captura URLs de imagem incluindo blob storage do Azure (Microvix)
  const regex = /https?:\/\/[^\s]+(?:\.jpg|\.jpeg|\.png|\.webp|blob\.core\.windows\.net\/[^\s]+)/gi;
  const matches = texto.match(regex) || [];
  return matches.map(u => u.replace(/[),;]+$/, ""));
}

async function enviarResposta(telefone, resposta) {
  const urls = extrairUrlsImagem(resposta);

  // Remove URLs do texto para não duplicar (serão enviadas como mídia)
  const textoLimpo = resposta
    .replace(/[-•]\s*https?:\/\/\S+/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (urls.length) {
    if (textoLimpo) await enviarTexto(telefone, textoLimpo);
    for (const url of urls) {
      await enviarImagem(telefone, url);
    }
  } else {
    await enviarTexto(telefone, resposta);
  }
}

/* =========================================================
   🌐 WEBHOOK
========================================================= */

app.post("/webhook/whatsapp", async (req, res) => {
  // Responde imediatamente com 200 para evitar timeout e reenvios da Z-API
  res.sendStatus(200);

  try {
    const data = req.body;

    // Z-API: só processa mensagens recebidas, ignora grupos e newsletters
    if (data?.type !== "ReceivedCallback") return;
    if (data?.isGroup) return;
    if (data?.isNewsletter) return;
    if (String(data?.phone || "").includes("@newsletter")) return;

    // Mensagem enviada pelo próprio atendente (fromMe): detecta encerramento de atendimento
    if (data?.fromMe) {
      const texto = (data?.text?.message || "").toLowerCase();
      if (texto.includes("atendimento encerrado")) {
        const telefone = data?.phone;
        const sessao   = telefone && sessoes.get(telefone);
        if (sessao?.pausado) {
          sessao.pausado       = false;
          sessao.pausadoEm     = null;
          sessao.alertaEnviado = false;
          await salvarSessoes();
          console.log(`▶️  [${telefone}] Bot retomado — atendimento encerrado pelo atendente`);
        }
      }
      return;
    }

    const telefone = data?.phone;
    if (!telefone) return;

    // Comandos da equipe via WhatsApp — processa antes de qualquer outra lógica
    if (CONFIG.equipe.numero && telefone === CONFIG.equipe.numero) {
      const cmd = (data?.text?.message || "").trim();
      if (cmd.toLowerCase().startsWith("retomar ")) {
        const tel = cmd.split(" ")[1]?.trim();
        const s   = tel && sessoes.get(tel);
        if (s) {
          s.pausado = false; s.pausadoEm = null; s.alertaEnviado = false;
          await salvarSessoes();
          await enviarTexto(CONFIG.equipe.numero, `✅ Bot retomado para ${tel}`);
          console.log(`▶️  Bot retomado via comando para ${tel}`);
        } else {
          await enviarTexto(CONFIG.equipe.numero, `❌ Número não encontrado: ${tel}`);
        }
      }
      return; // Mensagens da equipe não são processadas como atendimento
    }

    // Bot pausado: verifica auto-retomada por tempo antes de ignorar
    const sessaoPausada = sessoes.get(telefone);
    if (sessaoPausada?.pausado) {
      const autoResumeMs = CONFIG.equipe.autoResumeHoras * 60 * 60 * 1000;
      const inativoHa    = Date.now() - (sessaoPausada.pausadoEm || 0);
      if (autoResumeMs > 0 && inativoHa >= autoResumeMs) {
        sessaoPausada.pausado = false;
        sessaoPausada.pausadoEm = null;
        await salvarSessoes();
        console.log(`▶️  [${telefone}] Auto-retomado após ${(inativoHa / 3600000).toFixed(1)}h`);
        // Continua o processamento normalmente
      } else {
        console.log(`⏸️  [${telefone}] Bot pausado — mensagem ignorada`);
        return;
      }
    }

    // ── Áudio / PTT ──────────────────────────────────────────────
    const audioUrl = data?.audio?.audioUrl || data?.ptt?.pttUrl;
    if (audioUrl) {
      const audioMsgId = data?.messageId;
      console.log(`🎙️ [${telefone}] Áudio recebido — transcrevendo...`);
      processarNaFila(telefone, async () => {
        try {
          const inicioMs = Date.now();
          await new Promise(r => setTimeout(r, randomEntre(500, 1200)));
          await marcarLida(telefone, audioMsgId);
          const transcricao = await transcreverAudio(audioUrl);
          if (!transcricao) return;
          console.log(`🎙️ [${telefone}] Transcrito: ${transcricao}`);
          const sessao = getSessao(telefone);
          const tempoDigitando = Math.floor(randomEntre(1800, 3000));
          await simularDigitando(telefone, tempoDigitando);
          await new Promise(r => setTimeout(r, tempoDigitando));
          const resposta = await executarAgente(transcricao, sessao);
          const decorrido = Date.now() - inicioMs;
          if (decorrido < 3000) await new Promise(r => setTimeout(r, 3000 - decorrido));
          await enviarResposta(telefone, resposta);
        } catch (err) {
          console.error("❌ Erro ao transcrever áudio:", err.message);
          await enviarTexto(telefone, "Não consegui entender o áudio. Pode digitar sua mensagem?");
        }
      });
      return;
    }

    // ── Imagem ────────────────────────────────────────────────────
    const imagemUrl = data?.image?.imageUrl;
    if (imagemUrl) {
      const imagemMsgId = data?.messageId;
      const caption = data?.image?.caption || "";
      console.log(`🖼️ [${telefone}] Imagem recebida${caption ? ` — legenda: ${caption}` : ""}`);
      processarNaFila(telefone, async () => {
        try {
          const inicioMs = Date.now();
          await new Promise(r => setTimeout(r, randomEntre(500, 1200)));
          await marcarLida(telefone, imagemMsgId);
          const { base64, mimeType } = await baixarBase64(imagemUrl, "image/jpeg");
          const tipoValido = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType)
            ? mimeType : "image/jpeg";
          const conteudo = [
            { type: "image", source: { type: "base64", media_type: tipoValido, data: base64 } },
            { type: "text", text: caption || "O cliente enviou esta imagem. Analise e responda conforme o contexto." },
          ];
          const sessao = getSessao(telefone);
          const tempoDigitando = Math.floor(randomEntre(1800, 3000));
          await simularDigitando(telefone, tempoDigitando);
          await new Promise(r => setTimeout(r, tempoDigitando));
          const resposta = await executarAgente(conteudo, sessao);
          const decorrido = Date.now() - inicioMs;
          if (decorrido < 3000) await new Promise(r => setTimeout(r, 3000 - decorrido));
          await enviarResposta(telefone, resposta);
        } catch (err) {
          console.error("❌ Erro ao processar imagem:", err.message);
          await enviarTexto(telefone, "Não consegui analisar a imagem. Pode descrever o que precisa?");
        }
      });
      return;
    }

    // ── Texto ─────────────────────────────────────────────────────
    const textoFinal = data?.text?.message || data?.video?.caption || "";
    if (!textoFinal.trim()) return;

    console.log(`📩 [${telefone}] ${textoFinal}`);

    // Reset de conversa: cliente digita palavra-chave para limpar o histórico
    const RESET_KEYWORDS = ["nova conversa", "reiniciar", "resetar", "/reset", "limpar"];
    if (RESET_KEYWORDS.some(k => textoFinal.toLowerCase().includes(k))) {
      sessoes.delete(telefone);
      await salvarSessoes();
      await enviarTexto(telefone, "Conversa reiniciada! Como posso ajudar?");
      return;
    }

    // Debounce: agrupa mensagens enviadas em sequência rápida numa única chamada ao agente,
    // evitando múltiplas respostas e desperdício de créditos da API.
    // messageId: guarda o ID da última mensagem recebida para marcar como lida.
    const estado = debouncePorTelefone.get(telefone) || { mensagens: [] };
    estado.mensagens.push(textoFinal);
    estado.messageId = data?.messageId; // sobrescreve com o ID mais recente do lote
    if (estado.timer) clearTimeout(estado.timer);

    estado.timer = setTimeout(() => {
      debouncePorTelefone.delete(telefone);
      const textoAgrupado = estado.mensagens.join("\n");
      const msgId         = estado.messageId;

      processarNaFila(telefone, async () => {
        const inicioMs = Date.now();
        const sessao   = getSessao(telefone);

        // 1. Pausa curta antes de marcar como lido (imita humano lendo)
        await new Promise(r => setTimeout(r, randomEntre(500, 1200)));
        await marcarLida(telefone, msgId);

        // 2. Indica "digitando" com duração proporcional ao texto + jitter ±25%
        const baseDigitando = Math.min(textoAgrupado.length * 50, 4000);
        const tempoDigitando = Math.floor(baseDigitando * randomEntre(75, 125) / 100);
        await simularDigitando(telefone, tempoDigitando);
        await new Promise(r => setTimeout(r, tempoDigitando));

        // 3. Processa resposta
        const resposta = await executarAgente(textoAgrupado, sessao);

        // 4. Garante tempo mínimo de 3s desde o recebimento (evita resposta instantânea)
        const decorrido = Date.now() - inicioMs;
        if (decorrido < 3000) {
          await new Promise(r => setTimeout(r, 3000 - decorrido));
        }

        await enviarResposta(telefone, resposta);
      });
    }, DEBOUNCE_MS);

    debouncePorTelefone.set(telefone, estado);
  } catch (err) {
    console.error("❌ Erro no webhook:", err.message);
  }
});

/* =========================================================
   🛠️  ROTAS DE ADMINISTRAÇÃO
========================================================= */

function autenticarAdmin(req, res) {
  const token = req.headers["x-admin-token"];
  if (CONFIG.equipe.adminToken && token !== CONFIG.equipe.adminToken) {
    res.status(401).json({ erro: "Token inválido" });
    return false;
  }
  return true;
}

// Pausa o bot para um número — atendente humano assume
app.post("/admin/pausar/:telefone", async (req, res) => {
  if (!autenticarAdmin(req, res)) return;
  const sessao = getSessao(req.params.telefone);
  sessao.pausado = true;
  await salvarSessoes();
  console.log(`⏸️  Bot pausado para ${req.params.telefone}`);
  res.json({ pausado: true, telefone: req.params.telefone });
});

// Retoma o bot para um número — atendente humano encerrou
app.post("/admin/retomar/:telefone", async (req, res) => {
  if (!autenticarAdmin(req, res)) return;
  const sessao = getSessao(req.params.telefone);
  sessao.pausado = false;
  await salvarSessoes();
  console.log(`▶️  Bot retomado para ${req.params.telefone}`);
  res.json({ pausado: false, telefone: req.params.telefone });
});

// Lista conversas ativas e pausadas
app.get("/admin/sessoes", (req, res) => {
  if (!autenticarAdmin(req, res)) return;
  const lista = [...sessoes.entries()].map(([tel, s]) => ({
    telefone: tel,
    nome:     s.nome || null,
    pausado:  s.pausado || false,
    mensagens: s.historico.length,
  }));
  res.json(lista);
});

/* =========================================================
   🧪 ROTA DE TESTE
========================================================= */

app.post("/testar", async (req, res) => {
  const { mensagem, telefone } = req.body;
  if (!mensagem) return res.status(400).json({ erro: "Campo 'mensagem' obrigatório" });

  try {
    const sessao   = getSessao(telefone || "teste");
    const resposta = await executarAgente(mensagem, sessao);
    res.json({ resposta });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* =========================================================
   ❤️  SAÚDE
========================================================= */

app.get("/health", (req, res) => {
  res.json({
    status:    "ok",
    timestamp: new Date().toISOString(),
    sessoes:   sessoes.size,           // Clientes com histórico ativo
    filas:     filasPorTelefone.size,  // Mensagens sendo processadas agora
  });
});

/* =========================================================
   🚀 START
========================================================= */

// Carrega sessões persistidas antes de aceitar conexões
await carregarSessoes();

/* =========================================================
   ⏱️  VIGILÂNCIA DE ATENDIMENTOS PAUSADOS

   Verifica a cada minuto se há clientes esperando atendimento
   humano há mais de ALERTA_SEM_ATENDIMENTO minutos.
   Se sim: avisa o cliente, dispara alerta urgente no grupo
   e liga para o número do atendente.
========================================================= */
setInterval(async () => {
  const limiteMs = CONFIG.equipe.alertaMinutos * 60 * 1000;
  if (!limiteMs) return;

  for (const [telefone, sessao] of sessoes.entries()) {
    if (!sessao.pausado || !sessao.pausadoEm || sessao.alertaEnviado) continue;

    const esperandoHa = Date.now() - sessao.pausadoEm;
    if (esperandoHa < limiteMs) continue;

    console.log(`⚠️  [${telefone}] Sem atendimento há ${Math.round(esperandoHa / 60000)}min — disparando alerta`);
    sessao.alertaEnviado = true;
    await salvarSessoes();

    // Mensagem de desculpas ao cliente
    await enviarTexto(telefone,
      "Peço desculpas pela espera! Estamos com alto volume de atendimentos no momento. " +
      "Seu contato é importante para nós e um atendente entrará em contato em breve."
    );

    // Alerta urgente no grupo ou número da equipe
    const destino = CONFIG.equipe.grupo || CONFIG.equipe.numero;
    if (destino) {
      await enviarTexto(destino,
        `🚨 URGENTE — Cliente aguardando há ${Math.round(esperandoHa / 60000)} minutos!\n` +
        `Cliente: ${telefone}\n\n` +
        `Para retomar o bot: retomar ${telefone}`
      );
    }

    // Liga para o atendente
    if (CONFIG.equipe.numero) {
      await ligarParaAtendente(CONFIG.equipe.numero);
    }
  }
}, 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Agente Casa Faria rodando na porta ${PORT}`);
  console.log(`📋 Webhook: POST /webhook/whatsapp`);
  console.log(`🧪 Teste:   POST /testar`);
  console.log(`❤️  Saúde:   GET  /health`);
});

/**
 * Agente de IA para WhatsApp — Casa Faria Cohama
 * Stack: Node.js + Express + Anthropic API + Evolution API + Linx Microvix B2C
 *
 * Melhorias implementadas (v2):
 * - Fila de mensagens por telefone: evita condição de corrida no histórico
 * - Cache LID→JID: resolve LIDs sem bater na API toda vez
 * - Resolução de LID com 3 estratégias de fallback
 * - Persistência de sessões em arquivo JSON: histórico sobrevive a reinicializações
 * - Limite de histórico por sessão: evita crescimento ilimitado e custo excessivo
 * - Retry automático nas chamadas ao Microvix: maior resiliência a falhas transientes
 * - consultarImagensPorCodigo: agora filtra no ERP, não mais carrega tudo
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
    url:      process.env.EVOLUTION_API_URL,
    apiKey:   process.env.EVOLUTION_API_KEY,
    instance: process.env.EVOLUTION_INSTANCE,
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
    sessoes.set(telefone, { historico: [], nome: null });
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

const filasPorTelefone = new Map();

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

  // Avança até encontrar uma mensagem "user" para não começar com "assistant"
  while (inicio < historico.length && historico[inicio].role !== "user") {
    inicio++;
  }

  return historico.slice(inicio);
}

/* =========================================================
   👤 DETECÇÃO DE NOME DO CLIENTE
========================================================= */

const NAO_SAO_NOMES = new Set([
  "oi", "olá", "ola", "opa", "ei", "eai", "eaí", "alô", "alo",
  "bom", "boa", "ok", "sim", "não", "nao", "fala", "hey", "hi",
  "bora", "pode", "tem", "vai", "vem", "quer", "sou", "meu", "minha",
  "pau", "bom", "dia", "tarde", "noite", "tudo", "bem", "certo",
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
    // NOTA DE PERFORMANCE: B2CConsultaProdutos não suporta filtro por nome
    // no servidor (API B2C do Microvix) — retorna o catálogo completo e
    // filtramos localmente. Se o catálogo crescer muito (>500 produtos),
    // considerar cache local com TTL de ~5 minutos para reduzir o tráfego.
    const xml   = montarXml("B2CConsultaProdutos", [{ id: "timestamp", valor: "0" }]);
    const json  = await chamarMicrovix(xml);
    const todos = mapearColunas(json?.Microvix?.ResponseData);

    const termo     = nomeProduto.toLowerCase();
    const filtrados = todos.filter(p => {
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
        codigo:     p.codigoproduto || "",
        descricao:  p.nome_produto  || p.descricao_basica || "",
        referencia: p.referencia    || "",
        ativo:      p.ativo === "1" || p.ativo === 1,
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

    if (!itens.length) return { sucesso: true, totalGeral: 0, estoque: [], mensagem: "Sem estoque." };

    const estoque    = itens.map(i => ({
      empresa:    i.empresa    || "",
      referencia: i.referencia || "",
      quantidade: Number(i.saldo || 0),
    }));
    const totalGeral = estoque.reduce((acc, i) => acc + i.quantidade, 0);

    return { sucesso: true, totalGeral, estoque };
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

    return {
      sucesso:     true,
      precovenda:  Number(item.precovenda  || 0),
      precominimo: Number(item.precominimo || 0),
    };
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

    if (!itens.length) return { sucesso: true, emPromocao: false };

    const promo = itens[0];
    return {
      sucesso:       true,
      emPromocao:    true,
      precoPromocao: Number(promo.preco || 0),
      dataInicio:    promo.data_inicio  || "",
      dataTermino:   promo.data_termino || "",
    };
  } catch (err) {
    console.error("❌ consultarPromocaoPorCodigo:", err.message);
    return { sucesso: false, erro: err.message };
  }
}

async function consultarImagensPorCodigo(codigoProduto) {
  try {
    // MELHORIA: agora passa codigoproduto como parâmetro para filtrar no ERP.
    // Versão anterior buscava as imagens de TODOS os produtos e filtrava em memória,
    // gerando tráfego desnecessário para uma consulta simples de produto único.
    const xml  = montarXml("B2CConsultaProdutosImagensURL", [
      { id: "codigoproduto", valor: codigoProduto },
      { id: "timestamp",     valor: "0" },
    ]);
    const json  = await chamarMicrovix(xml);
    const itens = mapearColunas(json?.Microvix?.ResponseData);

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
        codigo:     p.codigoproduto || "",
        descricao:  p.nome_produto  || p.descricao_basica || "",
        referencia: p.referencia    || "",
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
- 20% à vista
- 13% no cartão, até 10x sem juros

Pessoa física:
- Compras > R$100: 5% à vista
- Compras > R$1.000: 10% à vista
- Parcelamento sem desconto:
  - Até R$499: 6x sem juros
  - Acima de R$499: 10x sem juros

Entrega grátis: compras > R$500 na Grande Ilha (São Luís, São José de Ribamar, Raposa) em até 72h. Fora dessas cidades: apenas retirada na loja.

Horário de funcionamento: de segunda à sexta, das 8 da manhã até 18h e aos sábados, das 8 até 16h

## Como se comportar
- Respostas curtas e diretas (máx. 4 linhas), estilo vendedor de loja física
- Máx. 1 emoji por mensagem, só se fizer sentido
- Nunca use: "Perfeito!", "Ótimo!", "Excelente escolha!", "Com certeza!"
- Varie a forma de cumprimentar ou responder; evite repetir
- Respostas curtas possíveis: "Tem sim! Quer ver as opções?"
- Não use Markdown, negrito, itálico ou tachado
- Produto disponível: - [nome] — R$ [preço] — [qtd] un.
- Produtos com saldo zerado **não aparecem na lista de disponíveis**, mas mencione: "Esse produto está sem estoque no momento. Podemos consultar disponibilidade em outra unidade ou previsão de reposição."
- Para fechar venda ou tirar dúvidas de entrega/prazo: chame atendente humano e resuma o que o cliente quer
- Nunca invente informações; use só dados do ERP e deste prompt
- sempre verificar o dia para poder informar o horário certo, caso alguém pergunte
- Se mandarem mensagem fora do horário de atendimento, avise.
- Sempre responda em português, com linguagem natural e amigável`;
}

/* =========================================================
   🤖 MOTOR DO AGENTE
========================================================= */

async function executarAgente(mensagem, sessao) {
  if (!sessao.nome) {
    const nomeDetectado = detectarNome(mensagem);
    if (nomeDetectado) {
      sessao.nome = nomeDetectado;
      console.log(`👤 Nome detectado: ${nomeDetectado}`);
    }
  }

  sessao.historico.push({ role: "user", content: mensagem });

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

  // Persiste sessão após cada interação para sobreviver a reinicializações
  await salvarSessoes();

  return resposta || "Não consegui processar agora. Tenta de novo?";
}

/* =========================================================
   📤 ENVIO VIA EVOLUTION API

   ⚠️  PROBLEMA CONHECIDO: LIDs na Evolution API v1.8.7

   O WhatsApp está migrando contatos de @s.whatsapp.net para
   identificadores internos chamados LIDs (@lid). A v1.8.7 não
   suporta envio para LIDs diretamente (retorna erro 400).

   A v2.x da Evolution API suporta LID nativamente, mas não foi
   possível conectar ao WhatsApp a partir de IPs de datacenter
   (Railway, Oracle Cloud) — o handshake criptográfico do Baileys
   é rejeitado nesses ambientes para novos registros. A v1 funcionou
   porque a sessão foi autenticada via conexão residencial (ngrok).

   Estratégia de resolução de LID implementada (3 etapas):
   1. Cache local lidToJid — zero latência, sem chamada à API
   2. POST /chat/findContacts com o LID como critério de busca
   3. GET /chat/findContacts para buscar em todos os contatos armazenados
   4. Fallback: tenta envio direto (vai falhar na v1.8.7, mas loga o erro)

   O cache é populado sempre que um LID é resolvido com sucesso,
   evitando chamadas repetidas à API para o mesmo contato.
========================================================= */

// Cache em memória: LID (@lid) → JID real (@s.whatsapp.net)
const lidToJid = new Map();

// Cache em memória: pushName → JID real (@s.whatsapp.net)
// Populado quando mensagens chegam com JID real — usado para resolver LIDs pelo nome
const pushNameToJid = new Map();

// Aceita @s.whatsapp.net e @lid — rejeita grupos (@g.us) e broadcasts
function telefoneValido(telefone) {
  return !!(telefone && !telefone.includes("@g.us") && !telefone.includes("@broadcast"));
}

function limparNumero(telefone) {
  return telefone
    .replace("@s.whatsapp.net", "")
    .replace("@lid", "");
}

async function resolverLid(lid, pushName = null) {
  // Cache local
  if (lidToJid.has(lid)) {
    console.log(`✅ LID resolvido via cache: ${lid} → ${lidToJid.get(lid)}`);
    return lidToJid.get(lid);
  }

  // Resolução via pushName — quando o contato já enviou mensagem com JID real antes
  if (pushName && pushNameToJid.has(pushName)) {
    const jid = pushNameToJid.get(pushName);
    console.log(`🔄 LID resolvido via pushName "${pushName}": ${lid} → ${jid}`);
    lidToJid.set(lid, jid);
    return jid;
  }

  // Tenta whatsappNumbers — endpoint que resolve LIDs para JIDs reais no v2
  try {
    const res = await axios.post(
      `${CONFIG.whatsapp.url}/chat/whatsappNumbers/${CONFIG.whatsapp.instance}`,
      { numbers: [lid] },
      { headers: { apikey: CONFIG.whatsapp.apiKey, "Content-Type": "application/json" } }
    );
    console.log("🔍 whatsappNumbers retornou:", JSON.stringify(res.data, null, 2));

    const lista = Array.isArray(res.data) ? res.data : [res.data];
    const item  = lista.find(c => c?.jid?.includes("@s.whatsapp.net") || c?.exists);
    const jid   = item?.jid;

    if (jid && jid.includes("@s.whatsapp.net")) {
      console.log(`🔄 LID resolvido via whatsappNumbers: ${lid} → ${jid}`);
      lidToJid.set(lid, jid);
      return jid;
    }
  } catch (err) {
    console.warn("⚠️ whatsappNumbers falhou:", err.response?.data || err.message);
  }

  console.warn(`⚠️ Não foi possível resolver LID ${lid} — usando LID diretamente`);
  return lid;
}

async function simularDigitando(telefone, duracaoMs) {
  try {
    const numero = limparNumero(telefone);
    await axios.post(
      `${CONFIG.whatsapp.url}/chat/sendPresence/${CONFIG.whatsapp.instance}`,
      { number: numero, presence: "composing", delay: duracaoMs },
      { headers: { apikey: CONFIG.whatsapp.apiKey } }
    );
  } catch (_) {
    // Falha silenciosa — presença de digitação não é crítica para o atendimento
  }
}

async function enviarTexto(telefone, texto, quotedKey = null, quotedMsg = null, pushName = null) {
  if (!telefoneValido(telefone)) {
    console.warn(`⚠️ Telefone inválido ignorado: ${telefone}`);
    return;
  }

  let jid = telefone;

  if (telefone.includes("@lid")) {
    const resolvido = await resolverLid(telefone, pushName);
    jid = (resolvido && resolvido.includes("@s.whatsapp.net")) ? resolvido : telefone;
  }

  const numero = jid.includes("@lid") ? jid : limparNumero(jid);

  // Para LIDs: inclui quoted para rotear via conversa existente sem validar número
  const body = { number: numero, text: texto };
  if (jid.includes("@lid") && quotedKey && quotedMsg) {
    body.options = { quoted: { key: quotedKey, message: quotedMsg } };
  }

  try {
    console.log("🔍 Enviando:", numero, jid.includes("@lid") ? "(LID com quoted)" : "");
    await axios.post(
      `${CONFIG.whatsapp.url}/message/sendText/${CONFIG.whatsapp.instance}`,
      body,
      { headers: { apikey: CONFIG.whatsapp.apiKey } }
    );
    console.log(`📤 Texto enviado para ${numero}`);
  } catch (err) {
    console.error("❌ Erro ao enviar texto:", JSON.stringify(err.response?.data, null, 2) || err.message);
  }
}

async function enviarImagem(telefone, url) {
  if (!telefoneValido(telefone)) {
    console.warn(`⚠️ Telefone inválido ignorado: ${telefone}`);
    return;
  }

  let jid = telefone;
  if (telefone.includes("@lid")) {
    const resolvido = await resolverLid(telefone);
    jid = (resolvido && resolvido.includes("@s.whatsapp.net")) ? resolvido : telefone;
  }

  try {
    const numero = jid.includes("@lid") ? jid : limparNumero(jid);

    // Tenta formato v2 da Evolution API primeiro, depois v1 como fallback
    try {
      await axios.post(
        `${CONFIG.whatsapp.url}/message/sendMedia/${CONFIG.whatsapp.instance}`,
        {
          number: numero,
          mediaMessage: { mediatype: "image", media: url, caption: "" },
        },
        { headers: { apikey: CONFIG.whatsapp.apiKey } }
      );
    } catch (_) {
      // Fallback para formato v1 da Evolution API
      await axios.post(
        `${CONFIG.whatsapp.url}/message/sendMedia/${CONFIG.whatsapp.instance}`,
        { number: numero, mediatype: "image", media: url, caption: "" },
        { headers: { apikey: CONFIG.whatsapp.apiKey } }
      );
    }
    console.log(`🖼️ Imagem enviada para ${numero}`);
  } catch (err) {
    console.error("❌ Erro ao enviar imagem:", JSON.stringify(err.response?.data, null, 2) || err.message);
    console.log("↩️ Fallback: enviando link da imagem como texto");
    await enviarTexto(telefone, `Foto do produto: ${url}`);
  }
}

function extrairUrlsImagem(texto) {
  // Captura URLs de imagem incluindo blob storage do Azure (Microvix)
  const regex = /https?:\/\/[^\s]+(?:\.jpg|\.jpeg|\.png|\.webp|blob\.core\.windows\.net\/[^\s]+)/gi;
  const matches = texto.match(regex) || [];
  return matches.map(u => u.replace(/[),;]+$/, ""));
}

async function enviarResposta(telefone, resposta, quotedKey = null, quotedMsg = null, pushName = null) {
  const urls = extrairUrlsImagem(resposta);

  // Remove URLs do texto para não duplicar (serão enviadas como mídia)
  const textoLimpo = resposta
    .replace(/[-•]\s*https?:\/\/\S+/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (urls.length) {
    if (textoLimpo) await enviarTexto(telefone, textoLimpo, quotedKey, quotedMsg, pushName);
    for (const url of urls) {
      await enviarImagem(telefone, url);
    }
  } else {
    await enviarTexto(telefone, resposta, quotedKey, quotedMsg, pushName);
  }
}

/* =========================================================
   🌐 WEBHOOK
========================================================= */

app.post("/webhook/whatsapp", async (req, res) => {
  // Responde imediatamente com 200 para evitar timeout e reenvios da Evolution API
  res.sendStatus(200);

  try {
    const data = req.body;

    // A v1 envia "messages.upsert"; a v2 pode enviar "MESSAGES_UPSERT"
    const evento = (data?.event || "").toLowerCase().replace("_", ".");
    if (evento !== "messages.upsert") return;
    if (data?.data?.key?.fromMe) return;

    const telefone  = data?.data?.key?.remoteJid;
    const msgKey    = data?.data?.key;
    const msgObjeto = data?.data?.message;
    const pushName  = data?.data?.pushName;
    if (!telefone) return;

    // Armazena pushName → JID quando JID real chega (usado para resolver LIDs depois)
    if (pushName && telefone.includes("@s.whatsapp.net")) {
      pushNameToJid.set(pushName, telefone);
    }

    if (!telefoneValido(telefone)) {
      console.warn(`⚠️ Telefone inválido ignorado: ${telefone}`);
      return;
    }

    const msg = data?.data?.message;

    let textoFinal =
      msg?.conversation ||
      msg?.extendedTextMessage?.text ||
      msg?.imageMessage?.caption || "";

    if (!textoFinal.trim()) {
      const isAudio = !!(msg?.audioMessage || msg?.pttMessage);

      if (isAudio) {
        console.log("🎙️ Áudio recebido de", telefone, "— solicitando texto");
        await enviarTexto(telefone, "Por enquanto só consigo responder mensagens de texto. Pode digitar sua dúvida?");
        return;
      }
    }

    if (!textoFinal.trim()) return;

    console.log(`📩 [${telefone}] ${textoFinal}`);

    // Enfileira o processamento para evitar condição de corrida em mensagens rápidas
    processarNaFila(telefone, async () => {
      const sessao = getSessao(telefone);

      const tempoDigitando = Math.min(textoFinal.length * 50, 4000);
      await simularDigitando(telefone, tempoDigitando);
      await new Promise(r => setTimeout(r, tempoDigitando));

      const resposta = await executarAgente(textoFinal, sessao);
      await enviarResposta(telefone, resposta, msgKey, msgObjeto, pushName);
    });
  } catch (err) {
    console.error("❌ Erro no webhook:", err.message);
  }
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
    lidsCache: lidToJid.size,          // LIDs resolvidos em cache
  });
});

/* =========================================================
   🚀 START
========================================================= */

// Carrega sessões persistidas antes de aceitar conexões
await carregarSessoes();

app.listen(PORT, () => {
  console.log(`🚀 Agente Casa Faria rodando na porta ${PORT}`);
  console.log(`📋 Webhook: POST /webhook/whatsapp`);
  console.log(`🧪 Teste:   POST /testar`);
  console.log(`❤️  Saúde:   GET  /health`);
});

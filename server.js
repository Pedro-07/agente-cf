/**
 * Agente de IA para WhatsApp — Casa Faria Cohama
 * Stack: Node.js + Express + Anthropic API + Evolution API + Linx Microvix B2C
 * Suporte a texto e áudio (transcrição via Claude)
 */

import express from "express";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import xml2js from "xml2js";

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
};

/* =========================================================
   🧠 MEMÓRIA DE CONVERSA (por número de telefone)
========================================================= */

const sessoes = new Map();

function getSessao(telefone) {
  if (!sessoes.has(telefone)) {
    sessoes.set(telefone, { historico: [], nome: null });
  }
  return sessoes.get(telefone);
}

/* =========================================================
   👤 DETECÇÃO DE NOME DO CLIENTE
========================================================= */

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

  return primeiroNome;
}

/* =========================================================
   🎙️ TRANSCRIÇÃO DE ÁUDIO VIA CLAUDE
========================================================= */

async function transcreverAudio(base64Audio, mimetype = "audio/ogg") {
  try {
    console.log("🎙️ Transcrevendo áudio com Claude...");

    const response = await anthropic.messages.create({
      model:      CONFIG.anthropic.model,
      max_tokens: 512,
      messages: [{
        role: "user",
        content: [
          {
            type:   "document",
            source: {
              type:       "base64",
              media_type: mimetype,
              data:       base64Audio,
            },
          },
          {
            type: "text",
            text: "Transcreva este áudio em português. Retorne apenas o texto transcrito, sem comentários.",
          },
        ],
      }],
    });

    const transcricao = response.content.find(b => b.type === "text")?.text?.trim() || null;
    console.log(`🎙️ Transcrito: ${transcricao}`);
    return transcricao;
  } catch (err) {
    console.error("❌ Erro ao transcrever áudio:", err.message);
    return null;
  }
}

/* =========================================================
   🔧 MICROVIX — helpers
========================================================= */

// ✅ <Name> com N maiúsculo — obrigatório pelo Microvix
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
  console.log("📤 XML Microvix:\n", xml);
  const res = await axios.post(CONFIG.microvix.url, xml, {
    headers: { "Content-Type": "application/xml" },
    timeout: 15000,
  });
  console.log("📥 Resposta Microvix:\n", res.data.substring(0, 500));
  return xml2js.parseStringPromise(res.data, { explicitArray: false });
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
    const xml  = montarXml("B2CConsultaProdutosImagensURL", [
      { id: "timestamp", valor: "0" },
    ]);
    const json  = await chamarMicrovix(xml);
    const itens = mapearColunas(json?.Microvix?.ResponseData);

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
    ? `O nome do cliente nesta conversa é ${nomeCliente}. Use o nome com naturalidade, não em toda mensagem — só quando fizer sentido.`
    : `Não temos o nome do cliente ainda. Se ele se apresentar, registre internamente.`;

  return `Você é um atendente da Casa Faria Cohama, loja de equipamentos para food service em São Luís - MA.

${saudacao}

## Sobre a Casa Faria
Loja especializada em equipamentos para restaurantes, hotéis, lanchonetes, bares, padarias, açougues e cozinhas em geral. Atendemos empresas (CNPJ) e pessoa física.

Endereço: Av. Daniel de La Touche, 2004 - Cohama, São Luís - MA
Maps: https://www.google.com/maps/dir//Casa+Faria,+Av.+Daniel+de+La+Touche,+2004+-+Cohama,+S%C3%A3o+Lu%C3%ADs+-+MA,+65074-115

## Principais categorias de produtos
- Açougue e Frigorífico: balcões açougue, moedores de carne, serra fita
- Inox e Mobiliário: mesas e prateleiras em inox
- Panificação e Confeitaria: amassadeiras, batedeiras, batedores de milk shake, masseiras, vitrines expositoras
- Refrigeração Comercial: refrigeradores, cervejeiras, balcões refrigerados, vitrines refrigeradas, freezers
- Restaurante e Cozinha Industrial: fornos, fogões, chapas, fritadeiras (cocção), buffets térmicos (conservação quente), processadores, extratores de suco (preparo)

## Descontos e condições comerciais

CNPJ com inscrição estadual ativa:
- 20% de desconto à vista
- 13% no cartão, parcelando em até 10x sem juros

Pessoa física:
- Compras acima de R$ 100: 5% de desconto (apenas à vista)
- Compras acima de R$ 1.000: 10% de desconto (apenas à vista)
- Parcelamento no cartão SEM desconto:
  - Até R$ 499: até 6x sem juros
  - Acima de R$ 499: até 10x sem juros

Entrega grátis para compras acima de R$ 500 dentro da Grande Ilha (São Luís, São José de Ribamar e Raposa) em até 72h (3 dias úteis).

## Como se comportar

- Respostas CURTAS — máximo 4 linhas. Direto como vendedor de loja física
- Use no máximo 1 emoji por mensagem, só quando fizer sentido
- NUNCA use: "Perfeito!", "Excelente escolha!", "Ótimo!", "Com certeza!"
- Varie as respostas — nunca repita a mesma abertura duas vezes seguidas
- Às vezes responda bem curto: "Tem sim! Quer ver as opções?"
- NUNCA use asteriscos, underlines ou qualquer marcação markdown
- Escreva texto limpo, sem negrito, itálico ou tachado — sem * _ ~ em nenhuma hipótese
- Quando mostrar produto use exatamente este formato (sem asteriscos): 🔹 [nome] — R$ [preço] — [qtd] un.
- Se preço vier zerado ou não encontrado: escreva "Preço sob consulta"
- Para fechar venda ou dúvidas de prazo/entrega: chame um atendente humano
- Ao chamar atendente, resuma o que o cliente quer: "Vou passar pro nosso atendente — ele já sabe que você quer a cervejeira GRBA-400PV branca."
- Nunca invente informações — use apenas dados do ERP e o que está neste prompt
- Responda sempre em português, com linguagem natural`;
}

/* =========================================================
   🤖 MOTOR DO AGENTE
========================================================= */

async function executarAgente(mensagem, sessao) {
  const { historico } = sessao;

  // Tenta detectar o nome do cliente se ainda não tiver
  if (!sessao.nome) {
    const nomeDetectado = detectarNome(mensagem);
    if (nomeDetectado) {
      sessao.nome = nomeDetectado;
      console.log(`👤 Nome detectado: ${nomeDetectado}`);
    }
  }

  historico.push({ role: "user", content: mensagem });

  let resposta     = null;
  let maxIteracoes = 10;

  while (maxIteracoes-- > 0) {
    const response = await anthropic.messages.create({
      model:      CONFIG.anthropic.model,
      max_tokens: 1024,
      system:     montarSystemPrompt(sessao.nome),
      tools,
      messages:   historico,
    });

    if (response.stop_reason === "end_turn") {
      resposta = response.content.find(b => b.type === "text")?.text || "";
      historico.push({ role: "assistant", content: response.content });
      break;
    }

    if (response.stop_reason === "tool_use") {
      historico.push({ role: "assistant", content: response.content });

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

      historico.push({ role: "user", content: resultados });
    }
  }

  return resposta || "Não consegui processar agora. Tenta de novo?";
}

/* =========================================================
   📤 ENVIO VIA EVOLUTION API
========================================================= */

async function simularDigitando(telefone, duracaoMs) {
  try {
    const numero = telefone.replace("@s.whatsapp.net", "");
    await axios.post(
      `${CONFIG.whatsapp.url}/chat/sendPresence/${CONFIG.whatsapp.instance}`,
      { number: numero, presence: "composing", delay: duracaoMs },
      { headers: { apikey: CONFIG.whatsapp.apiKey } }
    );
  } catch (_) {
    // Falha silenciosa — não é crítico
  }
}

// Aceita números reais (@s.whatsapp.net) e LIDs (@lid)
// LIDs são usados pelo WhatsApp para contatos não salvos na agenda
function telefoneValido(telefone) {
  return !!(telefone?.includes("@s.whatsapp.net") || telefone?.includes("@lid"));
}

function limparNumero(telefone) {
  return telefone
    .replace("@s.whatsapp.net", "")
    .replace("@lid", "");
}

async function enviarTexto(telefone, texto) {
  if (!telefoneValido(telefone)) {
    console.warn(`⚠️ Telefone inválido ignorado: ${telefone}`);
    return;
  }
  try {
    const numero = limparNumero(telefone);
    await axios.post(
      `${CONFIG.whatsapp.url}/message/sendText/${CONFIG.whatsapp.instance}`,
      { number: numero, textMessage: { text: texto } },
      { headers: { apikey: CONFIG.whatsapp.apiKey } }
    );
    console.log(`📤 Texto enviado para ${numero}`);
  } catch (err) {
    console.error("❌ Erro ao enviar texto:", err.response?.data || err.message);
  }
}

async function enviarImagem(telefone, url) {
  if (!telefoneValido(telefone)) {
    console.warn(`⚠️ Telefone inválido ignorado: ${telefone}`);
    return;
  }
  try {
    const numero = limparNumero(telefone);

    // Envia imagem via URL direta (funciona em todas as versões da Evolution API)
    // Tenta v2 primeiro, depois v1 como fallback
    try {
      await axios.post(
        `${CONFIG.whatsapp.url}/message/sendMedia/${CONFIG.whatsapp.instance}`,
        {
          number: numero,
          mediaMessage: {
            mediatype: "image",
            media:     url,
            caption:   "",
          },
        },
        { headers: { apikey: CONFIG.whatsapp.apiKey } }
      );
    } catch (e1) {
      // Fallback v1 da Evolution API
      await axios.post(
        `${CONFIG.whatsapp.url}/message/sendMedia/${CONFIG.whatsapp.instance}`,
        {
          number,
          mediatype: "image",
          media:     url,
          caption:   "",
        },
        { headers: { apikey: CONFIG.whatsapp.apiKey } }
      );
    }
    console.log(`🖼️ Imagem enviada para ${numero}`);
  } catch (err) {
    console.error("❌ Erro ao enviar imagem:", JSON.stringify(err.response?.data, null, 2) || err.message);
    console.error("❌ URL tentada:", url);
    console.log("↩️ Fallback: enviando link da imagem como texto");
    await enviarTexto(telefone, `Foto do produto: ${url}`);
  }
}

function extrairUrlsImagem(texto) {
  // Captura URLs de imagem incluindo blob storage do Azure (Microvix)
  // Aceita URLs com ou sem extensão explícita, terminando em espaço ou fim de linha
  const regex = /https?:\/\/[^\s]+(?:\.jpg|\.jpeg|\.png|\.webp|blob\.core\.windows\.net\/[^\s]+)/gi;
  const matches = texto.match(regex) || [];
  // Remove caracteres finais indesejados como ) , ; que possam ter sido capturados
  return matches.map(u => u.replace(/[),;]+$/, ""));
}

async function enviarResposta(telefone, resposta) {
  const urls = extrairUrlsImagem(resposta);

  // Remove todas as URLs do texto, junto com marcadores como "- " antes delas
  const textoLimpo = resposta
    .replace(/[-•]\s*https?:\/\/\S+/g, "")  // remove "- URL" ou "• URL"
    .replace(/https?:\/\/\S+/g, "")          // remove qualquer URL restante
    .replace(/\n{3,}/g, "\n\n")              // remove linhas em branco extras
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
  res.sendStatus(200);

  try {
    const data = req.body;

    if (data?.event !== "messages.upsert") return;
    if (data?.data?.key?.fromMe) return;

    const telefone = data?.data?.key?.remoteJid;
    if (!telefone) return;

    // Bloqueia apenas formatos completamente inválidos
    if (!telefoneValido(telefone)) {
      console.warn(`⚠️ Telefone inválido ignorado: ${telefone}`);
      return;
    }

    const msg = data?.data?.message;

    // ── Extrai texto ou transcreve áudio ──────────────────
    let textoFinal =
      msg?.conversation ||
      msg?.extendedTextMessage?.text ||
      msg?.imageMessage?.caption || "";

    if (!textoFinal.trim()) {
      const isAudio  = !!(msg?.audioMessage || msg?.pttMessage);
      const base64   = data?.data?.message?.base64;
      const mimetype = msg?.audioMessage?.mimetype || msg?.pttMessage?.mimetype || "audio/ogg";

      if (isAudio && base64) {
        console.log("🎙️ Áudio recebido de", telefone);
        await simularDigitando(telefone, 3000);

        textoFinal = await transcreverAudio(base64, mimetype);

        if (!textoFinal) {
          await enviarTexto(telefone, "Não consegui entender o áudio. Pode digitar sua mensagem?");
          return;
        }
      }
    }

    if (!textoFinal.trim()) return;

    console.log(`📩 [${telefone}] ${textoFinal}`);

    const sessao = getSessao(telefone);

    // Simula digitando por tempo proporcional (máx 4s)
    const tempoDigitando = Math.min(textoFinal.length * 50, 4000);
    await simularDigitando(telefone, tempoDigitando);
    await new Promise(r => setTimeout(r, tempoDigitando));

    const resposta = await executarAgente(textoFinal, sessao);
    await enviarResposta(telefone, resposta);
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
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* =========================================================
   🚀 START
========================================================= */

app.listen(PORT, () => {
  console.log(`🚀 Agente Casa Faria rodando na porta ${PORT}`);
  console.log(`📋 Webhook: POST /webhook/whatsapp`);
  console.log(`🧪 Teste:   POST /testar`);
  console.log(`❤️  Saúde:   GET  /health`);
});
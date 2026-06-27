const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const CSV_FILE_NAME = 'export_filtrado.csv';

function encontrarCSV() {
  const caminhos = [
    path.join(__dirname, CSV_FILE_NAME),
    '/app/data/export_filtrado.csv',
    '/app/data /export_filtrado.csv',
  ];
  for (const p of caminhos) {
    try {
      if (fs.existsSync(p)) {
        console.log(`✅ CSV encontrado em: ${p}`);
        return p;
      }
    } catch (e) {}
  }
  console.error('❌ CSV não encontrado');
  return null;
}

function parsarDataHora(data, hora) {
  if (!data) return 0;
  try {
    const [dia, mes, ano] = data.split('/');
    const horaLimpa = (hora || '00:00').replace('h', '').trim();
    const [h, m] = horaLimpa.split(':');
    return new Date(
      `${ano}-${mes}-${dia}T${h.padStart(2, '0')}:${(m || '00').padStart(2, '0')}:00-03:00`
    ).getTime();
  } catch (e) {
    return 0;
  }
}

const normalizarTexto = (v) =>
  String(v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

let cache = null;
let carregando = false;
let erroCarregamento = null;

function carregarCache() {
  return new Promise((resolve, reject) => {
    const csvPath = encontrarCSV();
    if (!csvPath) {
      const err = new Error('CSV não encontrado');
      erroCarregamento = err.message;
      return reject(err);
    }

    console.log('📂 Carregando CSV em cache (passada única)...');
    const inicio = Date.now();

    const mapaUnico = new Map();
    let maiorTs = -1;
    let dataFiltro = '';
    let totalLinhas = 0;

    fs.createReadStream(csvPath)
      .pipe(csv({ separator: ',' }))
      .on('data', (row) => {
        totalLinhas++;
        const tsDia = parsarDataHora(row['COLLECTION DATE'], '00:00');
        if (tsDia > maiorTs) {
          maiorTs = tsDia;
          dataFiltro = row['COLLECTION DATE'];
        }
        const tsLinha = parsarDataHora(row['COLLECTION DATE'], row['COLLECTION HOUR']);
        const chave = `${row['SKU']}__${row['MARKETPLACE']}__${row['SELLER OF MARKETPLACE'] || ''}`;
        const existente = mapaUnico.get(chave);
        if (!existente || tsLinha >= existente._ts) {
          mapaUnico.set(chave, { row, _ts: tsLinha, _data: row['COLLECTION DATE'] });
        }
      })
      .on('end', () => {
        const linhasFinais = [];
        for (const { row, _data } of mapaUnico.values()) {
          if (_data !== dataFiltro) continue;
          row.__busca = normalizarTexto(Object.values(row).join(' '));
          linhasFinais.push(row);
        }
        cache = linhasFinais;
        erroCarregamento = null;
        const ms = Date.now() - inicio;
        console.log(`📅 Data mais recente: ${dataFiltro}`);
        console.log(`✅ Cache: ${cache.length} registros únicos prontos (${totalLinhas} linhas lidas em ${ms}ms)`);
        resolve(cache);
      })
      .on('error', (err) => {
        erroCarregamento = err.message;
        console.error(`❌ Erro ao ler CSV: ${err.message}`);
        reject(err);
      });
  });
}

function iniciarCarregamento() {
  if (carregando) return;
  carregando = true;
  carregarCache()
    .catch((err) => console.error(`Erro ao carregar cache: ${err.message}`))
    .finally(() => { carregando = false; });
}

function precoEfetivo(row) {
  const spot    = parseFloat(row['SPOT PRICE OF MARKETPLACE']) || 0;
  const pix     = parseFloat(row['PIX PRICE']) || 0;
  const forward = parseFloat(row['FORWARD PRICE OF MARKETPLACE']) || 0;
  return pix > 0 ? pix : spot > 0 ? spot : forward;
}

function calcularPisoMercado(registrosSKU) {
  const precos = registrosSKU.map(precoEfetivo).filter((p) => p > 0);
  return precos.length ? Math.min(...precos) : 0;
}

function agruparPor(lista, campo) {
  return lista.reduce((acc, row) => {
    const key = row[campo] || 'DESCONHECIDO';
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});
}

// ─── ROTAS ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    cacheProntoEm: cache ? cache.length : null,
    carregando,
    erro: erroCarregamento,
  });
});

app.get('/api/produtos', (req, res) => {
  if (!cache) {
    return res.status(503).json({
      error: erroCarregamento
        ? `Falha ao carregar dados: ${erroCarregamento}`
        : 'Servidor ainda carregando, tente em alguns segundos.',
    });
  }
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(2000, parseInt(req.query.limit) || 500);
  const q     = normalizarTexto(req.query.q || '');
  const filtrados = q ? cache.filter((p) => p.__busca.includes(q)) : cache;
  const total  = filtrados.length;
  const inicio = (page - 1) * limit;
  const pagina = filtrados.slice(inicio, inicio + limit).map(({ __busca, ...resto }) => resto);
  console.log(`🔍 q="${q}" → ${total} resultados`);
  res.json({ total, page, limit, pages: Math.ceil(total / limit), data: pagina });
});

app.get('/api/resumo', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'Cache ainda carregando.' });

  const precos = cache.map(precoEfetivo).filter((p) => p > 0);
  const ticketMedio = precos.length ? precos.reduce((a, b) => a + b, 0) / precos.length : 0;

  const porMarketplace = agruparPor(cache, 'MARKETPLACE');
  const shareMarketplace = Object.entries(porMarketplace)
    .map(([nome, rows]) => {
      const ps = rows.map(precoEfetivo).filter((p) => p > 0);
      return {
        marketplace: nome,
        registros: rows.length,
        share: ((rows.length / cache.length) * 100).toFixed(1),
        ticketMedio: ps.length ? (ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(2) : '0',
      };
    })
    .sort((a, b) => b.registros - a.registros)
    .slice(0, 8);

  const canalLider = shareMarketplace[0] || null;

  const porCategoria = agruparPor(cache, 'CATEGORY');
  const topCategorias = Object.entries(porCategoria)
    .map(([cat, rows]) => ({
      categoria: cat,
      registros: rows.length,
      ticketMedio: (() => {
        const ps = rows.map(precoEfetivo).filter((p) => p > 0);
        return ps.length ? (ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(2) : '0';
      })(),
    }))
    .sort((a, b) => b.registros - a.registros)
    .slice(0, 6);

  const porMarca = agruparPor(cache, 'BRAND');
  const topMarcas = Object.entries(porMarca)
    .map(([marca, rows]) => ({ marca, registros: rows.length }))
    .sort((a, b) => b.registros - a.registros)
    .slice(0, 5);

  const dataColeta = cache[0]?.['COLLECTION DATE'] || 'N/A';

  res.json({
    dataColeta,
    totalRegistros: cache.length,
    ticketMedioGeral: ticketMedio.toFixed(2),
    canalLider,
    shareMarketplace,
    topCategorias,
    topMarcas,
  });
});

app.get('/api/alertas', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'Cache ainda carregando.' });

  const alertas = [];

  const porSKU = agruparPor(cache, 'SKU');
  const variacoesSKU = Object.entries(porSKU)
    .filter(([, rows]) => rows.length >= 2)
    .map(([sku, rows]) => {
      const precos = rows.map(precoEfetivo).filter((p) => p > 0);
      if (precos.length < 2) return null;
      const min = Math.min(...precos);
      const max = Math.max(...precos);
      const variacaoPerc = ((max - min) / max) * 100;
      const rowMin = rows.find((r) => precoEfetivo(r) === min);
      const rowMax = rows.find((r) => precoEfetivo(r) === max);
      return {
        sku,
        produto: rows[0]['PRODUCT'] || rows[0]['TITLE OF MARKETPLACE'] || sku,
        categoria: rows[0]['CATEGORY'] || '',
        precoMin: min.toFixed(2),
        precoMax: max.toFixed(2),
        variacaoPerc: variacaoPerc.toFixed(1),
        canalMaisBarato: rowMin?.['MARKETPLACE'] || '',
        canalMaisCaro: rowMax?.['MARKETPLACE'] || '',
        canaisMonitorados: rows.length,
      };
    })
    .filter(Boolean)
    .sort((a, b) => parseFloat(b.variacaoPerc) - parseFloat(a.variacaoPerc))
    .slice(0, 10);

  if (variacoesSKU.length > 0) {
    const top = variacoesSKU[0];
    alertas.push({
      tipo: 'VARIACAO_PRECO',
      severidade: parseFloat(top.variacaoPerc) > 20 ? 'CRITICO' : 'ATENCAO',
      titulo: 'Alta variação de preço entre canais',
      descricao: `SKU ${top.sku} tem variação de ${top.variacaoPerc}% entre canais (R$${top.precoMin} no ${top.canalMaisBarato} vs R$${top.precoMax} no ${top.canalMaisCaro}).`,
      topSKUs: variacoesSKU.slice(0, 5),
    });
  }

  const porMarketplace = agruparPor(cache, 'MARKETPLACE');
  const ticketsPorCanal = Object.entries(porMarketplace)
    .map(([mp, rows]) => {
      const ps = rows.map(precoEfetivo).filter((p) => p > 0);
      return {
        marketplace: mp,
        ticketMedio: ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0,
        registros: rows.length,
      };
    })
    .filter((c) => c.ticketMedio > 0)
    .sort((a, b) => a.ticketMedio - b.ticketMedio);

  if (ticketsPorCanal.length >= 2) {
    const maisBarato = ticketsPorCanal[0];
    const maisCaro   = ticketsPorCanal[ticketsPorCanal.length - 1];
    const diff = ((maisCaro.ticketMedio - maisBarato.ticketMedio) / maisCaro.ticketMedio) * 100;
    alertas.push({
      tipo: 'PRESSAO_MARGEM',
      severidade: diff > 15 ? 'CRITICO' : 'ATENCAO',
      titulo: 'Pressão de margem por canal',
      descricao: `${maisBarato.marketplace} pratica ticket médio ${diff.toFixed(1)}% abaixo de ${maisCaro.marketplace} (R$${maisBarato.ticketMedio.toFixed(2)} vs R$${maisCaro.ticketMedio.toFixed(2)}).`,
      rankingCanais: ticketsPorCanal.map((c) => ({ ...c, ticketMedio: c.ticketMedio.toFixed(2) })),
    });
  }

  const porCategoria = agruparPor(cache, 'CATEGORY');
  const dispersaoCat = Object.entries(porCategoria)
    .filter(([, rows]) => rows.length >= 5)
    .map(([cat, rows]) => {
      const ps = rows.map(precoEfetivo).filter((p) => p > 0);
      if (!ps.length) return null;
      const media = ps.reduce((a, b) => a + b, 0) / ps.length;
      const desvio = Math.sqrt(ps.reduce((a, b) => a + Math.pow(b - media, 2), 0) / ps.length);
      const cv = (desvio / media) * 100;
      return {
        categoria: cat,
        registros: rows.length,
        ticketMedio: media.toFixed(2),
        coeficienteVariacao: cv.toFixed(1),
        precoMin: Math.min(...ps).toFixed(2),
        precoMax: Math.max(...ps).toFixed(2),
      };
    })
    .filter(Boolean)
    .sort((a, b) => parseFloat(b.coeficienteVariacao) - parseFloat(a.coeficienteVariacao));

  if (dispersaoCat.length > 0) {
    const topCat = dispersaoCat[0];
    alertas.push({
      tipo: 'GUERRA_TARIFARIA',
      severidade: parseFloat(topCat.coeficienteVariacao) > 25 ? 'CRITICO' : 'ATENCAO',
      titulo: 'Alta dispersão de preço na categoria',
      descricao: `Categoria "${topCat.categoria}" apresenta coeficiente de variação de ${topCat.coeficienteVariacao}% (R$${topCat.precoMin} – R$${topCat.precoMax}). Possível guerra tarifária.`,
      topCategorias: dispersaoCat.slice(0, 5),
    });
  }

  const porSubcat = agruparPor(cache, 'SUBCATEGORY');
  const oportunidades = Object.entries(porSubcat)
    .filter(([, rows]) => rows.length >= 3)
    .map(([sub, rows]) => {
      const ps = rows.map(precoEfetivo).filter((p) => p > 0);
      const media = ps.reduce((a, b) => a + b, 0) / ps.length;
      return { subcategoria: sub, ticketMedio: media, registros: rows.length };
    })
    .sort((a, b) => b.ticketMedio - a.ticketMedio)
    .slice(0, 3);

  if (oportunidades.length > 0) {
    alertas.push({
      tipo: 'OPORTUNIDADE',
      severidade: 'INFO',
      titulo: 'Subcategorias com ticket premium',
      descricao: `"${oportunidades[0].subcategoria}" apresenta ticket médio de R$${oportunidades[0].ticketMedio.toFixed(2)} com estabilidade de preço — oportunidade de posicionamento.`,
      subcategorias: oportunidades.map((o) => ({ ...o, ticketMedio: o.ticketMedio.toFixed(2) })),
    });
  }

  res.json({ total: alertas.length, dataColeta: cache[0]?.['COLLECTION DATE'] || 'N/A', alertas });
});

app.get('/api/contexto-ia', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'Cache ainda carregando.' });

  const skuFiltro = normalizarTexto(req.query.sku || '');
  const qFiltro   = normalizarTexto(req.query.q || '');

  const precos = cache.map(precoEfetivo).filter((p) => p > 0);
  const ticketMedioGeral = precos.length
    ? (precos.reduce((a, b) => a + b, 0) / precos.length).toFixed(2)
    : '0';

  const porMarketplace = agruparPor(cache, 'MARKETPLACE');
  const canais = Object.entries(porMarketplace)
    .map(([mp, rows]) => {
      const ps = rows.map(precoEfetivo).filter((p) => p > 0);
      return {
        canal: mp,
        registros: rows.length,
        ticketMedio: ps.length ? (ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(2) : '0',
        share: ((rows.length / cache.length) * 100).toFixed(1) + '%',
      };
    })
    .sort((a, b) => b.registros - a.registros)
    .slice(0, 6);

  const porCategoria = agruparPor(cache, 'CATEGORY');
  const categorias = Object.entries(porCategoria)
    .map(([cat, rows]) => {
      const ps = rows.map(precoEfetivo).filter((p) => p > 0);
      return {
        categoria: cat,
        registros: rows.length,
        ticketMedio: ps.length ? (ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(2) : '0',
      };
    })
    .sort((a, b) => b.registros - a.registros)
    .slice(0, 5);

  let dadosSKU = null;
  if (skuFiltro) {
    const rowsSKU = cache.filter((r) => normalizarTexto(r['SKU']).includes(skuFiltro));
    if (rowsSKU.length > 0) {
      const ps = rowsSKU.map(precoEfetivo).filter((p) => p > 0);
      const pisoMercado = calcularPisoMercado(rowsSKU);
      dadosSKU = {
        sku: rowsSKU[0]['SKU'],
        produto: rowsSKU[0]['PRODUCT'] || rowsSKU[0]['TITLE OF MARKETPLACE'],
        categoria: rowsSKU[0]['CATEGORY'],
        subcategoria: rowsSKU[0]['SUBCATEGORY'],
        marca: rowsSKU[0]['BRAND'],
        totalOcorrencias: rowsSKU.length,
        precoMinimo: Math.min(...ps).toFixed(2),
        precoMaximo: Math.max(...ps).toFixed(2),
        precoMedio: (ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(2),
        pisoMercado: pisoMercado.toFixed(2),
        ocorrenciasPorCanal: Object.entries(agruparPor(rowsSKU, 'MARKETPLACE')).map(([mp, rows]) => ({
          canal: mp,
          preco: precoEfetivo(rows[0]).toFixed(2),
          seller: rows[0]['SELLER OF MARKETPLACE'] || '',
        })),
      };
    }
  }

  let resultadoBusca = null;
  if (qFiltro && !skuFiltro) {
    const encontrados = cache.filter((r) => r.__busca.includes(qFiltro)).slice(0, 20);
    resultadoBusca = encontrados.map((r) => ({
      sku: r['SKU'],
      produto: r['PRODUCT'] || r['TITLE OF MARKETPLACE'],
      marketplace: r['MARKETPLACE'],
      preco: precoEfetivo(r).toFixed(2),
      categoria: r['CATEGORY'],
    }));
  }

  const linhasCanais = canais.map(
    (c) => `  - ${c.canal}: ticket médio R$${c.ticketMedio}, ${c.share} do share, ${c.registros} registros`
  ).join('\n');

  const linhasCategorias = categorias.map(
    (c) => `  - ${c.categoria}: ticket médio R$${c.ticketMedio}, ${c.registros} registros`
  ).join('\n');

  let textoSKU = '';
  if (dadosSKU) {
    const canaisSKU = dadosSKU.ocorrenciasPorCanal
      .map((o) => `    • ${o.canal}: R$${o.preco}${o.seller ? ` (${o.seller})` : ''}`)
      .join('\n');
    textoSKU = `\nSKU ANALISADO: ${dadosSKU.sku}\nProduto: ${dadosSKU.produto}\nCategoria: ${dadosSKU.categoria} / ${dadosSKU.subcategoria}\nMarca: ${dadosSKU.marca}\nPreço mínimo no mercado: R$${dadosSKU.precoMinimo}\nPreço máximo no mercado: R$${dadosSKU.precoMaximo}\nPreço médio: R$${dadosSKU.precoMedio}\nPiso de mercado (menor preço encontrado): R$${dadosSKU.pisoMercado}\nOcorrências por canal:\n${canaisSKU}\n`;
  }

  let textoBusca = '';
  if (resultadoBusca && resultadoBusca.length > 0) {
    textoBusca = `\nPRODUTOS ENCONTRADOS PARA "${req.query.q}":\n` +
      resultadoBusca.map((r) => `  - SKU ${r.sku} | ${r.produto} | ${r.marketplace} | R$${r.preco}`).join('\n');
  }

  const systemPrompt = `Você é um analista de inteligência de mercado especializado em eletrodomésticos no Brasil.
Responda sempre em português, de forma direta e objetiva. Use os dados abaixo como base para suas análises.

=== DADOS DO MERCADO (${cache[0]?.['COLLECTION DATE'] || 'N/A'}) ===

Total de registros monitorados: ${cache.length}
Ticket médio geral: R$${ticketMedioGeral}

CANAIS DIGITAIS MONITORADOS:
${linhasCanais}

CATEGORIAS MONITORADAS:
${linhasCategorias}
${textoSKU}${textoBusca}
=== FIM DOS DADOS ===

Ao responder: seja direto, cite números concretos, indique o canal/SKU específico quando relevante, e finalize com uma recomendação de ação clara.`;

  res.json({
    systemPrompt,
    metadados: {
      totalRegistros: cache.length,
      dataColeta: cache[0]?.['COLLECTION DATE'] || 'N/A',
      ticketMedioGeral,
      totalCanais: canais.length,
      totalCategorias: categorias.length,
      skuEncontrado: dadosSKU ? true : false,
    },
    dadosSKU,
    resultadoBusca,
  });
});

// ─── PROXY GROQ API ───────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY não configurada no servidor.' });
  }

  const { messages, systemPrompt, skuParam } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Campo "messages" é obrigatório e deve ser um array.' });
  }

  try {
    let system = systemPrompt;
    if (!system && cache) {
      const precos = cache.map(r => {
        const spot = parseFloat(r['SPOT PRICE OF MARKETPLACE']) || 0;
        const pix  = parseFloat(r['PIX PRICE']) || 0;
        const fwd  = parseFloat(r['FORWARD PRICE OF MARKETPLACE']) || 0;
        return pix > 0 ? pix : spot > 0 ? spot : fwd;
      }).filter(p => p > 0);

      const ticketMedio = precos.length
        ? (precos.reduce((a, b) => a + b, 0) / precos.length).toFixed(2)
        : '0';

      const porMP = cache.reduce((acc, r) => {
        const k = r['MARKETPLACE'] || 'DESCONHECIDO';
        if (!acc[k]) acc[k] = [];
        acc[k].push(r);
        return acc;
      }, {});

      const canais = Object.entries(porMP)
        .map(([mp, rows]) => {
          const ps = rows.map(r => {
            const spot = parseFloat(r['SPOT PRICE OF MARKETPLACE']) || 0;
            const pix  = parseFloat(r['PIX PRICE']) || 0;
            const fwd  = parseFloat(r['FORWARD PRICE OF MARKETPLACE']) || 0;
            return pix > 0 ? pix : spot > 0 ? spot : fwd;
          }).filter(p => p > 0);
          return {
            canal: mp,
            registros: rows.length,
            ticketMedio: ps.length ? (ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(2) : '0',
            share: ((rows.length / cache.length) * 100).toFixed(1) + '%',
          };
        })
        .sort((a, b) => b.registros - a.registros)
        .slice(0, 6);

      const linhasCanais = canais.map(c =>
        `  - ${c.canal}: ticket médio R$${c.ticketMedio}, ${c.share} do share, ${c.registros} registros`
      ).join('\n');

      let textoSKU = '';
      if (skuParam) {
        const norm = v => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const rowsSKU = cache.filter(r => norm(r['SKU']).includes(norm(skuParam)));
        if (rowsSKU.length > 0) {
          const ps = rowsSKU.map(r => {
            const spot = parseFloat(r['SPOT PRICE OF MARKETPLACE']) || 0;
            const pix  = parseFloat(r['PIX PRICE']) || 0;
            const fwd  = parseFloat(r['FORWARD PRICE OF MARKETPLACE']) || 0;
            return pix > 0 ? pix : spot > 0 ? spot : fwd;
          }).filter(p => p > 0);
          const min = Math.min(...ps);
          const max = Math.max(...ps);
          const med = (ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(2);
          const canaisSKU = Object.entries(
            rowsSKU.reduce((acc, r) => { const k = r['MARKETPLACE'] || '?'; if (!acc[k]) acc[k] = r; return acc; }, {})
          ).map(([mp, r]) => {
            const spot = parseFloat(r['SPOT PRICE OF MARKETPLACE']) || 0;
            const pix  = parseFloat(r['PIX PRICE']) || 0;
            const fwd  = parseFloat(r['FORWARD PRICE OF MARKETPLACE']) || 0;
            const p = pix > 0 ? pix : spot > 0 ? spot : fwd;
            return `    • ${mp}: R$${p.toFixed(2)}`;
          }).join('\n');
          textoSKU = `\nSKU ANALISADO: ${rowsSKU[0]['SKU']}\nProduto: ${rowsSKU[0]['PRODUCT'] || rowsSKU[0]['TITLE OF MARKETPLACE']}\nPreço mínimo: R$${min.toFixed(2)} | Máximo: R$${max.toFixed(2)} | Médio: R$${med}\nOcorrências por canal:\n${canaisSKU}\n`;
        }
      }

      system = `Você é um analista de inteligência de mercado especializado em eletrodomésticos no Brasil.
Responda sempre em português, de forma direta e objetiva. Use os dados abaixo como base para suas análises.

=== DADOS DO MERCADO (${cache[0]?.['COLLECTION DATE'] || 'N/A'}) ===
Total de registros monitorados: ${cache.length}
Ticket médio geral: R$${ticketMedio}

CANAIS DIGITAIS MONITORADOS:
${linhasCanais}
${textoSKU}
=== FIM DOS DADOS ===

Ao responder: seja direto, cite números concretos dos dados acima, indique o canal/SKU específico quando relevante, e finalize com uma recomendação de ação clara.`;
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: system },
          ...messages.map(m => ({
            role: m.role === 'ai' ? 'assistant' : m.role,
            content: m.content,
          })),
        ],
        max_tokens: 1000,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Erro Groq API:', err);
      return res.status(response.status).json({ error: 'Erro na Groq API.', detalhe: err });
    }

    const data = await response.json();
    const texto = data.choices?.[0]?.message?.content ?? 'Sem resposta.';
    res.json({ resposta: texto });

  } catch (err) {
    console.error('Erro no proxy /api/chat:', err.message);
    res.status(500).json({ error: 'Erro interno no proxy.', detalhe: err.message });
  }
});

// ─── SERVIDOR ─────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚀 SERVIDOR RODANDO NA PORTA ${PORT}`);
  console.log(`==================================================`);
  iniciarCarregamento();
});

server.setTimeout(120000);
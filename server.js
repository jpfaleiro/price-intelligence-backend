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
    .finally(() => {
      carregando = false;
    });
}

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Rota raiz
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    cacheProntoEm: cache ? cache.length : null,
    carregando,
    erro: erroCarregamento,
  });
});

// API de produtos
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

  const filtrados = q
    ? cache.filter((p) => p.__busca.includes(q))
    : cache;

  const total  = filtrados.length;
  const inicio = (page - 1) * limit;

  const pagina = filtrados.slice(inicio, inicio + limit).map(({ __busca, ...resto }) => resto);

  console.log(`🔍 q="${q}" → ${total} resultados`);
  res.json({ total, page, limit, pages: Math.ceil(total / limit), data: pagina });
});

// Inicia o servidor
const server = app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚀 SERVIDOR RODANDO NA PORTA ${PORT}`);
  console.log(`==================================================`);
  iniciarCarregamento();
});

// Timeout de segurança
server.setTimeout(120000); // 2 minutos
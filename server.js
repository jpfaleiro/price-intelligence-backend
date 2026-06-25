const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const CSV_FILE_NAME = 'export_midea_31_13.csv';
const csvPath = path.join('/app/data', CSV_FILE_NAME);

let cache = null;
let carregando = false;

// Converte "13/06/2026" + "15:00h" em número comparável
function parsarDataHora(data, hora) {
  if (!data) return 0;
  const [dia, mes, ano] = data.split('/');
  const horaLimpa = (hora || '00:00h').replace('h', '').trim();
  const [h, m] = horaLimpa.split(':');
  return new Date(`${ano}-${mes}-${dia}T${h.padStart(2,'0')}:${(m||'00').padStart(2,'0')}:00`).getTime();
}

function carregarCSV() {
  return new Promise((resolve, reject) => {
    if (cache) return resolve(cache);
    if (carregando) {
      const intervalo = setInterval(() => {
        if (cache) { clearInterval(intervalo); resolve(cache); }
      }, 200);
      return;
    }

    carregando = true;
    console.log('📂 Iniciando leitura do CSV...');
    const todos = [];

    fs.createReadStream(csvPath)
      .pipe(csv({ separator: ',' }))
      .on('data', (data) => {
        todos.push(data);
        if (todos.length % 100000 === 0) {
          console.log(`📦 ${todos.length.toLocaleString()} registros lidos...`);
        }
      })
      .on('end', () => {
        console.log(`✅ Total bruto: ${todos.length.toLocaleString()} registros`);

        // 1. Encontrar a data mais recente no CSV
        let maiorData = 0;
        todos.forEach(r => {
          const ts = parsarDataHora(r['COLLECTION DATE'], '00:00');
          if (ts > maiorData) maiorData = ts;
        });

        // Formatar de volta para comparação com string
        const dataMaisRecente = new Date(maiorData);
        const diaR = String(dataMaisRecente.getDate()).padStart(2, '0');
        const mesR = String(dataMaisRecente.getMonth() + 1).padStart(2, '0');
        const anoR = dataMaisRecente.getFullYear();
        const dataFiltro = `${diaR}/${mesR}/${anoR}`;
        console.log(`📅 Data mais recente detectada: ${dataFiltro}`);

        // 2. Filtrar só os registros da data mais recente
        const doDiaRecente = todos.filter(r => r['COLLECTION DATE'] === dataFiltro);
        console.log(`📋 Registros na data mais recente: ${doDiaRecente.length.toLocaleString()}`);

        // 3. Para cada SKU + MARKETPLACE, manter apenas o registro da hora mais recente
        const mapaUnico = new Map();
        doDiaRecente.forEach(r => {
          const chave = `${r['SKU']}__${r['MARKETPLACE']}__${r['SELLER OF MARKETPLACE'] || ''}`;
          const tsAtual = parsarDataHora(r['COLLECTION DATE'], r['COLLECTION HOUR']);
          const existente = mapaUnico.get(chave);
          if (!existente || tsAtual > parsarDataHora(existente['COLLECTION DATE'], existente['COLLECTION HOUR'])) {
            mapaUnico.set(chave, r);
          }
        });

        cache = [...mapaUnico.values()];
        carregando = false;
        console.log(`✅ Cache final: ${cache.length.toLocaleString()} registros únicos (SKU + Marketplace + Seller, hora mais recente)`);
        if (cache.length > 0) {
          console.log(`📋 Campos detectados:`, Object.keys(cache[0]));
        }
        resolve(cache);
      })
      .on('error', (err) => {
        carregando = false;
        reject(err);
      });
  });
}

if (fs.existsSync(csvPath)) {
  carregarCSV().catch(err => console.error('Erro ao pré-carregar CSV:', err.message));
} else {
  console.error(`❌ Arquivo CSV não encontrado: ${csvPath}`);
}

app.get('/api/produtos', async (req, res) => {
  try {
    const dados = await carregarCSV();
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(2000, parseInt(req.query.limit) || 500);
    const q     = req.query.q
      ? req.query.q.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      : null;

    console.log(`🔍 Busca: q="${q}" | cache: ${dados.length} registros`);

    const filtrados = q
      ? dados.filter(p =>
          Object.values(p).some(v =>
            v && String(v).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(q)
          )
        )
      : dados;

    console.log(`✅ Encontrados: ${filtrados.length} registros`);

    const total  = filtrados.length;
    const inicio = (page - 1) * limit;
    const pagina = filtrados.slice(inicio, inicio + limit);

    res.json({
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      data: pagina
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚀 SERVIDOR RODANDO NA PORTA ${PORT}`);
  console.log(`🔗 Endpoint: http://localhost:${PORT}/api/produtos`);
  console.log(`🔍 Busca:    http://localhost:${PORT}/api/produtos?q=midea`);
  console.log(`==================================================`);
});
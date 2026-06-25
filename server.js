const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());
const CSV_FILE_NAME = 'export_filtrado.csv';
function encontrarCSV() {
  const caminhos = [
    '/app/data /export_filtrado.csv',
    '/app/data/export_filtrado.csv',
    path.join(__dirname, CSV_FILE_NAME),
  ];
  for (const p of caminhos) {
    try {
      if (fs.existsSync(p)) {
        console.log(✅ CSV encontrado em: ${p});
        return p;
      }
    } catch(e) {}
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
    return new Date(${ano}-${mes}-${dia}T${h.padStart(2,'0')}:${(m||'00').padStart(2,'0')}:00).getTime();
  } catch(e) { return 0; }
}
let cache = null;
function carregarCache() {
  return new Promise((resolve, reject) => {
    const csvPath = encontrarCSV();
    if (!csvPath) return reject(new Error('CSV não encontrado'));
    console.log('📂 Carregando CSV em cache...');
    const mapaUnico = new Map();
    let maiorTs = 0;
    let dataFiltro = '';
    // Primeira passagem: descobrir data mais recente
    const rows = [];
    fs.createReadStream(csvPath)
      .pipe(csv({ separator: ',' }))
      .on('data', (row) => {
        rows.push(row);
        const ts = parsarDataHora(row['COLLECTION DATE'], '00:00');
        if (ts > maiorTs) { maiorTs = ts; dataFiltro = row['COLLECTION DATE']; }
      })
      .on('end', () => {
        console.log(📅 Data mais recente: ${dataFiltro});
        // Filtrar e deduplicar
        rows.forEach(row => {
          if (row['COLLECTION DATE'] !== dataFiltro) return;
          const chave = ${row['SKU']}__${row['MARKETPLACE']}__${row['SELLER OF MARKETPLACE'] || ''};
          const tsRow = parsarDataHora(row['COLLECTION DATE'], row['COLLECTION HOUR']);
          const existente = mapaUnico.get(chave);
          if (!existente || tsRow > parsarDataHora(existente['COLLECTION DATE'], existente['COLLECTION HOUR'])) {
            mapaUnico.set(chave, row);
          }
        });
        cache = [...mapaUnico.values()];
        console.log(✅ Cache: ${cache.length} registros únicos prontos);
        resolve(cache);
      })
      .on('error', reject);
  });
}
const normalizarTexto = (v) =>
  String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
app.get('/api/produtos', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'Servidor ainda carregando, tente em alguns segundos.' });
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(2000, parseInt(req.query.limit) || 500);
  const q     = normalizarTexto(req.query.q || '');
  const filtrados = q
    ? cache.filter(p => Object.values(p).some(v => normalizarTexto(v).includes(q)))
    : cache;
  const total  = filtrados.length;
  const inicio = (page - 1) * limit;
  const pagina = filtrados.slice(inicio, inicio + limit);
  console.log(🔍 q="${q}" → ${total} resultados);
  res.json({ total, page, limit, pages: Math.ceil(total / limit), data: pagina });
});
app.listen(PORT, () => {
  console.log(==================================================);
  console.log(🚀 SERVIDOR RODANDO NA PORTA ${PORT});
  console.log(==================================================);
  carregarCache().catch(err => console.error('Erro ao carregar cache:', err.message));
});
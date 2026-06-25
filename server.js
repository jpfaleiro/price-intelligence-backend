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
        console.log(`✅ CSV encontrado em: ${p}`);
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
    return new Date(`${ano}-${mes}-${dia}T${h.padStart(2,'0')}:${(m||'00').padStart(2,'0')}:00`).getTime();
  } catch(e) { return 0; }
}

// Lê o CSV uma única vez, filtra e deduplica
function buscarNoCSV(csvPath, query, limit, page) {
  return new Promise((resolve, reject) => {
    const normalizarTexto = (v) =>
      String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const queryNorm = normalizarTexto(query);

    let maiorTs = 0;
    let dataFiltro = '';
    const registrosPorChave = new Map();

    fs.createReadStream(csvPath)
      .pipe(csv({ separator: ',' }))
      .on('data', (row) => {
        // Rastrear data mais recente em tempo real
        const ts = parsarDataHora(row['COLLECTION DATE'], '00:00');
        if (ts > maiorTs) {
          maiorTs = ts;
          dataFiltro = row['COLLECTION DATE'];
        }

        // Guardar provisoriamente todos os registros que passam no filtro de query
        if (queryNorm) {
          const match = Object.values(row).some(v => normalizarTexto(v).includes(queryNorm));
          if (!match) return;
        }

        const chave = `${row['COLLECTION DATE']}__${row['SKU']}__${row['MARKETPLACE']}__${row['SELLER OF MARKETPLACE'] || ''}`;
        const tsRow = parsarDataHora(row['COLLECTION DATE'], row['COLLECTION HOUR']);
        const existente = registrosPorChave.get(chave);
        if (!existente || tsRow > parsarDataHora(existente['COLLECTION DATE'], existente['COLLECTION HOUR'])) {
          registrosPorChave.set(chave, row);
        }
      })
      .on('end', () => {
        console.log(`📅 Data mais recente: ${dataFiltro}`);

        // Filtrar apenas a data mais recente
        const todos = [...registrosPorChave.values()].filter(r => r['COLLECTION DATE'] === dataFiltro);
        const total = todos.length;
        const inicio = (page - 1) * limit;
        const pagina = todos.slice(inicio, inicio + limit);

        console.log(`✅ Retornando ${pagina.length} de ${total} registros`);
        resolve({ total, page, limit, pages: Math.ceil(total / limit), data: pagina });
      })
      .on('error', reject);
  });
}

app.get('/api/produtos', async (req, res) => {
  try {
    const csvPath = encontrarCSV();
    if (!csvPath) return res.status(500).json({ error: 'CSV não encontrado no servidor.' });

    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(2000, parseInt(req.query.limit) || 500);
    const q     = req.query.q || '';

    console.log(`🔍 Busca: q="${q}" | page=${page} | limit=${limit}`);
    const resultado = await buscarNoCSV(csvPath, q, limit, page);
    res.json(resultado);
  } catch (err) {
    console.error('Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚀 SERVIDOR RODANDO NA PORTA ${PORT}`);
  console.log(`==================================================`);
  encontrarCSV();
});
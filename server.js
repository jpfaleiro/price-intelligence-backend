const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const CSV_FILE_NAME = 'export_midea_31_13.csv';

// Tenta encontrar o CSV em múltiplos caminhos possíveis
function encontrarCSV() {
  const caminhos = [
    path.join('/app/data ', CSV_FILE_NAME),
    path.join('/app/data', CSV_FILE_NAME),
    path.join(__dirname, CSV_FILE_NAME),
    path.join(__dirname, 'data', CSV_FILE_NAME),
  ];
  for (const p of caminhos) {
    if (fs.existsSync(p)) {
      console.log(`✅ CSV encontrado em: ${p}`);
      return p;
    }
  }
  console.error('❌ CSV não encontrado em nenhum caminho:', caminhos);
  return null;
}

function parsarDataHora(data, hora) {
  if (!data) return 0;
  const [dia, mes, ano] = data.split('/');
  const horaLimpa = (hora || '00:00h').replace('h', '').trim();
  const [h, m] = horaLimpa.split(':');
  return new Date(`${ano}-${mes}-${dia}T${h.padStart(2,'0')}:${(m||'00').padStart(2,'0')}:00`).getTime();
}

// Busca por stream — não carrega tudo na RAM
function buscarNoCSV(csvPath, query, limit, page) {
  return new Promise((resolve, reject) => {
    const normalizarTexto = (v) =>
      String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const queryNorm = normalizarTexto(query);

    // Primeiro passo: achar a data mais recente e filtrar
    const todasDatas = new Set();
    const registrosPorChave = new Map();

    fs.createReadStream(csvPath)
      .pipe(csv({ separator: ',' }))
      .on('data', (row) => {
        const data = row['COLLECTION DATE'];
        if (data) todasDatas.add(data);
      })
      .on('end', () => {
        // Descobrir data mais recente
        let maiorTs = 0;
        let dataFiltro = '';
        todasDatas.forEach(d => {
          const [dia, mes, ano] = d.split('/');
          const ts = new Date(`${ano}-${mes}-${dia}`).getTime();
          if (ts > maiorTs) { maiorTs = ts; dataFiltro = d; }
        });

        console.log(`📅 Data mais recente: ${dataFiltro}`);

        // Segundo passo: filtrar por data + query + deduplicar
        fs.createReadStream(csvPath)
          .pipe(csv({ separator: ',' }))
          .on('data', (row) => {
            if (row['COLLECTION DATE'] !== dataFiltro) return;

            if (queryNorm) {
              const match = Object.values(row).some(v =>
                normalizarTexto(v).includes(queryNorm)
              );
              if (!match) return;
            }

            const chave = `${row['SKU']}__${row['MARKETPLACE']}__${row['SELLER OF MARKETPLACE'] || ''}`;
            const tsAtual = parsarDataHora(row['COLLECTION DATE'], row['COLLECTION HOUR']);
            const existente = registrosPorChave.get(chave);
            if (!existente || tsAtual > parsarDataHora(existente['COLLECTION DATE'], existente['COLLECTION HOUR'])) {
              registrosPorChave.set(chave, row);
            }
          })
          .on('end', () => {
            const todos = [...registrosPorChave.values()];
            const total = todos.length;
            const inicio = (page - 1) * limit;
            const pagina = todos.slice(inicio, inicio + limit);
            console.log(`✅ Encontrados: ${total} registros únicos`);
            resolve({ total, page, limit, pages: Math.ceil(total / limit), data: pagina });
          })
          .on('error', reject);
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
  console.log(`🔗 Endpoint: http://localhost:${PORT}/api/produtos`);
  console.log(`==================================================`);

  // Verificar CSV na inicialização
  encontrarCSV();
});
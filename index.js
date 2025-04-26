// index.js
console.log('⚡️ Iniciando server mínimo');

const express = require('express');
const app = express();

app.get('/', (req, res) => res.send('API NuvemChat está UP!'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server ouvindo na porta ${port}`));

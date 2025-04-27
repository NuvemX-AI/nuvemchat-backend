// routes/instagram.js
const express = require('express');
const router = express.Router();

const INSTAGRAM_CLIENT_ID = process.env.INSTAGRAM_CLIENT_ID;
const INSTAGRAM_REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI;

router.get('/auth/instagram', async (req, res) => {
  try {
    const scope = 'user_profile,user_media'; // permissões
    const authUrl = `https://api.instagram.com/oauth/authorize?client_id=${INSTAGRAM_CLIENT_ID}&redirect_uri=${encodeURIComponent(INSTAGRAM_REDIRECT_URI)}&scope=${scope}&response_type=code`;

    res.json({ url: authUrl });
  } catch (error) {
    console.error('Erro ao gerar URL de autorização Instagram:', error);
    res.status(500).json({ message: 'Erro ao gerar URL de autorização' });
  }
});

module.exports = router;


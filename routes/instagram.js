// routes/instagram.js
const express = require('express');
const router = express.Router();
require('dotenv').config();

// /api/instagram/connect
router.post('/connect', async (req, res) => {
  try {
    const clientId = process.env.INSTAGRAM_CLIENT_ID;
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    const instagramAuthUrl = `https://api.instagram.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user_profile,user_media&response_type=code`;

    return res.status(200).json({ url: instagramAuthUrl });
  } catch (error) {
    console.error('Erro ao gerar URL de autorização do Instagram:', error.message);
    return res.status(500).json({ message: 'Erro ao conectar com Instagram' });
  }
});

module.exports = router;

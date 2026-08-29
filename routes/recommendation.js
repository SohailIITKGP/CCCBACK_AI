// routes/recommendation.js

const express = require('express');
const router = express.Router();
const { recommendProperties, recommendClient } = require('../controllers/recommendation');

router.get('/recommend/:clientId', recommendProperties);
router.get('/recommend/property/:propertyId', recommendClient);

module.exports = router;

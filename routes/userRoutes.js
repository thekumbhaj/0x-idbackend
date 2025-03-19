const express = require('express');
const router = express.Router();
const { getUserRole } = require('../controllers/userController');

router.get("/:userId", getUserRole);

module.exports = router;
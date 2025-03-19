const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');
const { getAllUsers } = require('../controllers/adminController');

router.get('/admin/users', verifyToken, getAllUsers);

module.exports = router;
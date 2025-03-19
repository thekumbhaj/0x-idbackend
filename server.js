require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/authRoutes');
const kycRoutes = require('./routes/kycRoutes');
const adminRoutes = require('./routes/adminRoutes');
const userRoutes = require('./routes/userRoutes');
const { db } = require('./config/db');
const { initializeMoralis } = require('./services/moralisService');
const { verifyToken } = require('./middleware/authMiddleware');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(cors());
app.use('/uploads', express.static(path.join(__dirname, '../uploads'))); // Corrected path

// Routes
app.use(authRoutes);
app.use(kycRoutes);
app.use(adminRoutes);
app.use(userRoutes);

// Initialize Moralis
initializeMoralis().catch(console.error);

// Start Server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
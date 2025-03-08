const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2');
const multer = require('multer');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Tesseract = require('tesseract.js');


dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(cors());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// MySQL Connection
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

db.connect((err) => {
  if (err) {
    console.error('Error connecting to MySQL:', err);
    process.exit(1); // Exit the process if the database connection fails
  }
  console.log('MySQL Connected');
});

// JWT Middleware
const verifyToken = (req, res, next) => {
  const token = req.header('Authorization')?.split(' ')[1]; // Extract Bearer token
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = decoded; // Attach user data to request
    next();
  });
};

// Nodemailer Setup
const mailAuth = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL,
    pass: process.env.MAIL_PASSWORD,
  },
});

// File Upload Setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage });

// Helper Function: Send OTP Email
const sendSecuredappOTPMail = async (otp, mail) => {
  const mailOptions = {
    from: process.env.MAIL,
    to: mail,
    subject: 'SecureX-ID Email Verification OTP',
    text: `Dear User,

      To verify your email address, use the OTP: ${otp}

      This OTP is valid for 5 minutes. Do not share it with anyone.

      Best regards,
      SecureX-ID Team`,
  };

  mailAuth.sendMail(mailOptions, (error, info) => {
    if (error) console.error('Error sending email:', error);
    else console.log('Email sent:', info.response);
  });
};

// Routes

// 1. Signup
app.post('/signup', async (req, res) => {
  const { full_name, email, phone_number, password } = req.body;

  if (!full_name || !email || !phone_number || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpExpiry = new Date(Date.now() + 5 * 60000); // 5 minutes

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    db.query(
      'INSERT INTO users (full_name, email, phone_number, password, otp, otp_expiry) VALUES (?, ?, ?, ?, ?, ?)',
      [full_name, email, phone_number, hashedPassword, otp, otpExpiry],
      (err) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Database error' });
        }

        sendSecuredappOTPMail(otp, email);
        res.status(201).json({ message: 'OTP sent to your email' });
      }
    );
  } catch (error) {
    console.error('Error hashing password:', error);
    res.status(500).json({ error: 'Error hashing password' });
  }
});

// 2. Verify OTP
app.post('/verify-otp', (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  db.query(
    'SELECT * FROM users WHERE email = ? AND otp = ? AND otp_expiry > NOW()',
    [email, otp],
    (err, results) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (results.length === 0) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
      }

      db.query('UPDATE users SET is_verified = TRUE WHERE email = ?', [email], (err) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Database error' });
        }
        res.status(200).json({ message: 'Account verified successfully' });
      });
    }
  );
});


// 3. Login (JWT Token)
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const user = results[0];

    if (!user.is_verified) {
      return res.status(403).json({ error: 'Please verify your email before logging in' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    // Include is_admin in JWT
    const token = jwt.sign(
      { user_id: user.id, email: user.email, is_admin: user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(200).json({ message: 'Login successful', token, is_admin: user.is_admin });
  });
});


// 5. Check KYC Status (Protected Route)
app.get('/kyc-status/:user_id', verifyToken, (req, res) => {
  const { user_id } = req.params;

  db.query('SELECT status FROM kyc WHERE user_id = ?', [user_id], (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'KYC record not found' });
    }

    res.status(200).json({ status: results[0].status });
  });
});


////OCR START FROM HERE 

// Helper function for OCR
//with new entry wallet address 
const extractTextFromImage = async (imagePath) => {
  try {
    const { data: { text } } = await Tesseract.recognize(imagePath, 'eng');
    return text.trim();
  } catch (error) {
    console.error('OCR Error:', error);
    return null;
  }
};

// 4. Upload KYC Documents (Protected Route with OCR and Wallet Address)
app.post('/upload-kyc', verifyToken, upload.fields([
  { name: 'front_id', maxCount: 1 },
  { name: 'back_id', maxCount: 1 },
  { name: 'selfie_with_id', maxCount: 1 },
]), async (req, res) => {
  const { user_id, wallet_address } = req.body;
  const files = req.files;

  if (!user_id || !wallet_address || !files.front_id || !files.back_id || !files.selfie_with_id) {
    return res.status(400).json({ error: 'All fields and files are required' });
  }

  try {
    // Extract text using OCR
    const frontIdText = await extractTextFromImage(files.front_id[0].path);
    const backIdText = await extractTextFromImage(files.back_id[0].path);
    
    console.log('Extracted Front ID Text:', frontIdText);
    console.log('Extracted Back ID Text:', backIdText);
    console.log('Wallet Address:', wallet_address);

    // Save details into database
    db.query(
      'INSERT INTO kyc (user_id, front_id, back_id, selfie_with_id, front_id_text, back_id_text, wallet_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [user_id, files.front_id[0].path, files.back_id[0].path, files.selfie_with_id[0].path, frontIdText, backIdText, wallet_address],
      (err) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Database error' });
        }
        res.status(201).json({ message: 'KYC documents uploaded, text extracted, and wallet address saved successfully' });
      }
    );
  } catch (error) {
    console.error('Error processing OCR:', error);
    res.status(500).json({ error: 'Error extracting text from images' });
  }
});

nos
// 6. Update KYC Status (Admin Only)
app.post('/update-kyc-status', verifyToken, (req, res) => {
  const { user_id, status } = req.body;

  // Ensure only admins can update KYC status
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Access denied. Admins only.' });
  }

  if (!user_id || !status) {
    return res.status(400).json({ error: 'User ID and status are required' });
  }

  db.query('UPDATE kyc SET status = ? WHERE user_id = ?', [status, user_id], (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'KYC record not found' });
    }

    // Fetch user email
    db.query('SELECT email FROM users WHERE id = ?', [user_id], (err, users) => {
      if (err || users.length === 0) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Error fetching user email' });
      }

      const userEmail = users[0].email;

      // Send KYC status update email
      const mailOptions = {
        from: process.env.MAIL,
        to: userEmail,
        subject: 'SecureX-ID KYC Status Update',
        text: `Dear User,\n\nYour KYC status has been updated to: ${status}.\n\nBest Regards,\nSecureX-ID Team`,
      };

      mailAuth.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.error('Error sending email:', error);
          return res.status(500).json({ error: 'Error sending email' });
        }
        console.log('Email sent:', info.response);
        res.status(200).json({ message: 'KYC status updated and email sent successfully' });
      });
    });
  });
});


//onchain- hash



// Start Server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
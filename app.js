require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2/promise');
const multer = require('multer');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Tesseract = require('tesseract.js');
const Moralis = require('moralis').default;
const path = require('path');
const web3Service = require('./src/web3Service'); // Import the new Web3 service

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(cors());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// MySQL Connection
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Moralis Setup
const initializeMoralis = async () => {
  await Moralis.start({ apiKey: process.env.MORALIS_API_KEY });
};
initializeMoralis().catch(console.error);

// JWT Middleware
const verifyToken = (req, res, next) => {
  const token = req.header('Authorization')?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = decoded;
    next();
  });
};

// Nodemailer Setup
const mailAuth = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.MAIL, pass: process.env.MAIL_PASSWORD },
});

// File Upload Setup
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, 'uploads/'),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// Helper Functions
const sendSecuredappOTPMail = (otp, mail) => {
  const mailOptions = {
    from: process.env.MAIL,
    to: mail,
    subject: 'SecureX-ID Email Verification OTP',
    text: `Dear User,\n\nTo verify your email, use OTP: ${otp}\n\nValid for 5 minutes. Do not share.\n\nBest regards,\nSecureX-ID Team`,
  };
  mailAuth.sendMail(mailOptions, (error, info) => {
    if (error) console.error('Email error:', error);
    else console.log('Email sent:', info.response);
  });
};

const extractTextFromImage = async (imagePath) => {
  try {
    const { data: { text } } = await Tesseract.recognize(imagePath, 'eng');
    return text.trim();
  } catch (error) {
    console.error('OCR Error:', error);
    return null;
  }
};

const getAssetTransfers = async (walletAddress, fromDate, toDate) => {
  const response = await Moralis.EvmApi.transaction.getWalletTransactions({
    chain: '0x13882',
    address: walletAddress,
    fromDate: fromDate.toISOString().split('T')[0],
    toDate: toDate.toISOString().split('T')[0],
  });
  return response.result;
};

// Routes

// 1. Signup
app.post('/signup', async (req, res) => {
  const { full_name, email, phone_number, password } = req.body;
  if (!full_name || !email || !phone_number || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpExpiry = new Date(Date.now() + 5 * 60000);

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await db.query(
      'INSERT INTO users (full_name, email, phone_number, password, otp, otp_expiry) VALUES (?, ?, ?, ?, ?, ?)',
      [full_name, email, phone_number, hashedPassword, otp, otpExpiry]
    );
    sendSecuredappOTPMail(otp, email);
    res.status(201).json({ message: 'OTP sent to your email' });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// 2. Verify OTP
app.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  try {
    const [results] = await db.query(
      'SELECT * FROM users WHERE email = ? AND otp = ? AND otp_expiry > NOW()',
      [email, otp]
    );
    if (!results.length) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    await db.query('UPDATE users SET is_verified = TRUE WHERE email = ?', [email]);
    res.status(200).json({ message: 'Account verified successfully' });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// 3. Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const [results] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!results.length) {
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

    const token = jwt.sign(
      { user_id: user.id, email: user.email, is_admin: user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.status(200).json({ message: 'Login successful', token, is_admin: user.is_admin });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// 4. Upload KYC Documents


const preprocessImage = async (imagePath, type) => {
  try {
    let pipeline = sharp(imagePath)
      .grayscale()           // Convert to grayscale for better OCR
      .resize(2000)          // Resize to a consistent width
      .sharpen()             // Enhance edges
      .normalize();          // Adjust contrast

    if (type === 'front') {
      pipeline = pipeline.threshold(150); // Binary threshold for front ID
    } else {
      pipeline = pipeline.median(3);      // Noise reduction for back ID
    }

    const preprocessedPath = `uploads/preprocessed_${path.basename(imagePath)}`;
    await pipeline.toFile(preprocessedPath);
    return preprocessedPath;
  } catch (error) {
    console.error('Preprocessing error:', error);
    return imagePath; // Fallback to original image if preprocessing fails
  }
};

const extractStructuredData = async (imagePath, type) => {
  try {
    const preprocessedPath = await preprocessImage(imagePath, type);

    // Tesseract configuration
    const config = {
      lang: 'eng',
      oem: 1,              // LSTM OCR Engine
      psm: type === 'front' ? 6 : 11, // Page segmentation mode: block for front, sparse for back
      logger: m => console.debug(m)    // Debug logging
    };

    // Character whitelist for OCR
    if (type === 'front') {
      config.tessedit_char_whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/- ';
    } else {
      config.tessedit_char_whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/-,#. ';
    }

    const { data: { text } } = await Tesseract.recognize(preprocessedPath, 'eng', config);
    const structuredData = processExtractedText(text, type);
    return { rawText: text, structuredData };
  } catch (error) {
    console.error('OCR Error:', error);
    throw error;
  }
};
const processExtractedText = (text, type) => {
  const result = {};
  const cleanText = text.replace(/\s+/g, ' ').trim(); // Normalize whitespace

  if (type === 'front') {
    // Extract Full Name (assumes first two lines are the name)
    result.fullName = cleanText.split('\n').slice(0, 2).join(' ').replace(/[^A-Za-z ]/g, '');

    // Extract Date of Birth (e.g., DD/MM/YYYY or DD-MM-YYYY)
    const dobMatch = cleanText.match(/(\d{2}[\/\- ]{1}\d{2}[\/\- ]{1}\d{4})/);
    result.dob = dobMatch ? dobMatch[0].replace(/ /g, '') : null;

    // Extract 16-digit ID Number
    const idMatch = cleanText.match(/\b\d{16}\b/);
    result.idNumber = idMatch ? idMatch[0] : null;

    // Validation for front ID
    if (!result.fullName || result.fullName.split(' ').length < 2) {
      throw new Error('Invalid name format');
    }
    if (!result.dob || !/^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(result.dob)) {
      throw new Error('Invalid date of birth');
    }
    if (!result.idNumber || result.idNumber.length !== 16) {
      throw new Error('Invalid ID number');
    }
  } else if (type === 'back') {
    // Extract Address (assumes last 3 relevant lines after keyword or long text)
    const addressLines = cleanText.split('\n')
      .filter(line => 
        line.toLowerCase().includes('address') || 
        line.match(/[A-Za-z0-9, ]{10,}/)
      )
      .slice(-3); // Take last 3 lines
    result.address = addressLines.join(', ').replace(/(^, )|(, $)/g, '');

    // Validation for back ID
    if (!result.address || result.address.length < 10) {
      throw new Error('Address not properly extracted');
    }
  }

  return result;
};

// Assuming verifyToken and upload middleware are defined elsewhere
app.post(
  '/upload-kyc',
  verifyToken,
  upload.fields([
    { name: 'front_id', maxCount: 1 },
    { name: 'back_id', maxCount: 1 },
    { name: 'selfie_with_id', maxCount: 1 }
  ]),
  async (req, res) => {
    const { user_id, wallet_address } = req.body;
    const files = req.files;

    // Input validation
    if (!user_id || !wallet_address || !files.front_id || !files.back_id || !files.selfie_with_id) {
      return res.status(400).json({ error: 'All fields and files are required' });
    }

    try {
      // Process front and back ID images
      const frontResult = await extractStructuredData(files.front_id[0].path, 'front');
      const backResult = await extractStructuredData(files.back_id[0].path, 'back');

      const frontText = frontResult.rawText;
      const backText = backResult.rawText;
      const frontData = frontResult.structuredData;
      const backData = backResult.structuredData;

      // Log extracted data for debugging
      console.log('Structured Front Data:', frontData);
      console.log('Structured Back Data:', backData);

      // Insert into database (assuming db is a MySQL connection pool)
      await db.query(
        `INSERT INTO kyc 
        (user_id, front_id, back_id, selfie_with_id, 
         front_id_text, back_id_text, 
         full_name, dob, id_number, address, wallet_address) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user_id,
          files.front_id[0].path,         // Path to original front image
          files.back_id[0].path,          // Path to original back image
          files.selfie_with_id[0].path,   // Path to selfie image
          frontText,                      // Raw OCR text from front
          backText,                       // Raw OCR text from back
          frontData.fullName,
          frontData.dob,
          frontData.idNumber,
          backData.address,
          wallet_address
        ]
      );

      // Success response
      res.status(201).json({
        message: 'KYC documents processed successfully',
        data: { ...frontData, ...backData }
      });
    } catch (error) {
      console.error('Upload KYC error:', error);
      const status = error.message.includes('Invalid') ? 400 : 500;
      res.status(status).json({
        error: 'KYC processing failed',
        details: error.message
      });
    }
  }
);
//<-------------------------------------------------------------------------------------------------->
// // Enhanced OCR Preprocessing Functions
// const preprocessImage = async (imagePath, type) => {
//   try {
//     let pipeline = sharp(imagePath)
//       .grayscale()
//       .resize(2000) // Increased resolution
//       .sharpen()
//       .normalize();

//     if (type === 'front') {
//       pipeline = pipeline.threshold(150); // Aggressive threshold for printed text
//     } else {
//       pipeline = pipeline.median(3); // Noise reduction for addresses
//     }

//     const preprocessedPath = `uploads/preprocessed_${path.basename(imagePath)}`;
//     await pipeline.toFile(preprocessedPath);
//     return preprocessedPath;
//   } catch (error) {
//     console.error('Preprocessing error:', error);
//     return imagePath; // Fallback to original
//   }
// };

// // Enhanced OCR Extraction with Structured Data
// const extractStructuredData = async (imagePath, type) => {
//   try {
//     const preprocessedPath = await preprocessImage(imagePath, type);
    
//     const config = {
//       lang: 'eng',
//       oem: 1, // LSTM OCR Engine
//       psm: type === 'front' ? 6 : 11, // Different segmentation for front/back
//       logger: m => console.debug(m) // Optional: for debugging
//     };

//     // Add whitelist based on document type
//     if (type === 'front') {
//       config.tessedit_char_whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/- ';
//     } else {
//       config.tessedit_char_whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/-,#. ';
//     }

//     const { data: { text } } = await Tesseract.recognize(preprocessedPath, 'eng', config);
//     return processExtractedText(text, type);
//   } catch (error) {
//     console.error('OCR Error:', error);
//     return null;
//   }
// };

// // Text Processing and Validation
// const processExtractedText = (text, type) => {
//   const result = {};
//   const cleanText = text.replace(/\s+/g, ' ').trim();

//   if (type === 'front') {
//     // Extract Full Name (First 2 lines assumed to be name)
//     result.fullName = cleanText.split('\n').slice(0,2).join(' ').replace(/[^A-Za-z ]/g, '');
    
//     // Extract DOB using date pattern
//     const dobMatch = cleanText.match(/(\d{2}[\/\- ]{1}\d{2}[\/\- ]{1}\d{4})/);
//     result.dob = dobMatch ? dobMatch[0].replace(/ /g, '') : null;
    
//     // Extract 16-digit ID
//     const idMatch = cleanText.match(/\b\d{16}\b/);
//     result.idNumber = idMatch ? idMatch[0] : null;
    
//   } else if (type === 'back') {
//     // Extract Address (assumed to be 3-5 lines after keywords)
//     const addressLines = cleanText.split('\n').filter(line => 
//       line.toLowerCase().includes('address') || 
//       line.match(/[A-Za-z0-9, ]{10,}/)
//     ).slice(-3); // Take last 3 relevant lines
    
//     result.address = addressLines.join(', ').replace(/(^, )|(, $)/g, '');
//   }

//   // Validation Checks
//   if (type === 'front') {
//     if (!result.fullName || result.fullName.split(' ').length < 2) {
//       throw new Error('Invalid name format');
//     }
//     if (!result.dob || !/^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(result.dob)) {
//       throw new Error('Invalid date of birth');
//     }
//     if (!result.idNumber || result.idNumber.length !== 16) {
//       throw new Error('Invalid ID number');
//     }
//   } else if (type === 'back' && (!result.address || result.address.length < 10)) {
//     throw new Error('Address not properly extracted');
//   }

//   return result;
// };

// // Updated KYC Upload Route
// app.post(
//   '/upload-kyc',
//   verifyToken,
//   upload.fields([{ name: 'front_id', maxCount: 1 }, { name: 'back_id', maxCount: 1 }, { name: 'selfie_with_id', maxCount: 1 }]),
//   async (req, res) => {
//     const { user_id, wallet_address } = req.body;
//     const files = req.files;

//     if (!user_id || !wallet_address || !files.front_id || !files.back_id || !files.selfie_with_id) {
//       return res.status(400).json({ error: 'All fields and files are required' });
//     }

//     try {
//       // Process front and back separately
//       const frontData = await extractStructuredData(files.front_id[0].path, 'front');
//       const backData = await extractStructuredData(files.back_id[0].path, 'back');

//       console.log('Structured Front Data:', frontData);
//       console.log('Structured Back Data:', backData);

//       // Store structured data in database
//       await db.query(
//         `INSERT INTO kyc 
//         (user_id, front_id, back_id, selfie_with_id, 
//          full_name, dob, id_number, address, wallet_address) 
//         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//         [
//           user_id, 
//           files.front_id[0].path, 
//           files.back_id[0].path, 
//           files.selfie_with_id[0].path,
//           frontData.fullName,
//           frontData.dob,
//           frontData.idNumber,
//           backData.address,
//           wallet_address
//         ]
//       );

//       res.status(201).json({ 
//         message: 'KYC documents processed successfully',
//         data: { ...frontData, ...backData }
//       });

//     } catch (error) {
//       console.error('Upload KYC error:', error);
//       const status = error.message.includes('Invalid') ? 400 : 500;
//       res.status(status).json({ 
//         error: 'KYC processing failed',
//         details: error.message
//       });
//     }
//   }
// );
//last code with normal ocr----<---------------------------------------------------------------------===>
// app.post(
//   '/upload-kyc',
//   verifyToken,
//   upload.fields([{ name: 'front_id', maxCount: 1 }, { name: 'back_id', maxCount: 1 }, { name: 'selfie_with_id', maxCount: 1 }]),
//   async (req, res) => {
//     const { user_id, wallet_address } = req.body;
//     const files = req.files;

//     if (!user_id || !wallet_address || !files.front_id || !files.back_id || !files.selfie_with_id) {
//       return res.status(400).json({ error: 'All fields and files are required' });
//     }

//     try {
//       const frontIdText = await extractTextFromImage(files.front_id[0].path);
//       const backIdText = await extractTextFromImage(files.back_id[0].path);

//       console.log('Extracted Front ID Text:', frontIdText);
//       console.log('Extracted Back ID Text:', backIdText);
//       console.log('Wallet Address:', wallet_address);

//       await db.query(
//         'INSERT INTO kyc (user_id, front_id, back_id, selfie_with_id, front_id_text, back_id_text, wallet_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
//         [user_id, files.front_id[0].path, files.back_id[0].path, files.selfie_with_id[0].path, frontIdText, backIdText, wallet_address]
//       );
//       res.status(201).json({ message: 'KYC documents uploaded and text extracted' });
//     } catch (error) {
//       console.error('Upload KYC error:', error);
//       res.status(500).json({ error: 'Server error' });
//     }
//   }
// );

// 5. Check KYC Statusdress 
app.get('/kyc-status/:user_id', verifyToken, async (req, res) => {
  const { user_id } = req.params;

  try {
    // Fetch KYC status and wallet address from the database
    const [results] = await db.query(
      'SELECT status, wallet_address FROM kyc WHERE user_id = ?',
      [user_id]
    );

    // If no KYC record is found, return a 404 error
    if (!results.length) {
      return res.status(404).json({ error: 'KYC record not found' });
    }

    // Return the KYC status and wallet address
    res.status(200).json({
      status: results[0].status,
      wallet_address: results[0].wallet_address,
    });
  } catch (error) {
    console.error('KYC status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// 6. Update KYC Status (Admin Only)
app.post('/update-kyc-status', verifyToken, async (req, res) => {
  const { user_id, status } = req.body;

  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Access denied. Admins only.' });
  }
  if (!user_id || !status) {
    return res.status(400).json({ error: 'User ID and status are required' });
  }

  try {
    const [result] = await db.query('UPDATE kyc SET status = ? WHERE user_id = ?', [status, user_id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'KYC record not found' });
    }

    const [users] = await db.query('SELECT email FROM users WHERE id = ?', [user_id]);
    if (!users.length) {
      return res.status(500).json({ error: 'User not found' });
    }

    const userEmail = users[0].email;
    const mailOptions = {
      from: process.env.MAIL,
      to: userEmail,
      subject: 'SecureX-ID KYC Status Update',
      text: `Dear User,\n\nYour KYC status is now: ${status}.\n\nBest Regards,\nSecureX-ID Team`,
    };

    mailAuth.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('Email error:', error);
        return res.status(500).json({ error: 'Email sending failed' });
      }
      console.log('Email sent:', info.response);
      res.status(200).json({ message: 'KYC status updated and email sent' });
    });
  } catch (error) {
    console.error('Update KYC error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// 7. Approve KYC (On-Chain with Web3.js using web3Service)
app.post('/approve-kyc', verifyToken, async (req, res) => {
  const { user_id } = req.body;

  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Access denied. Admins only.' });
  }
  if (!user_id) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const [userResults] = await db.query(
      'SELECT full_name, wallet_address FROM users u LEFT JOIN kyc k ON u.id = k.user_id WHERE u.id = ?',
      [user_id]
    );
    if (!userResults.length || !userResults[0].wallet_address) {
      return res.status(404).json({ error: 'User or wallet address not found' });
    }

    const { full_name, wallet_address } = userResults[0];
    const [kycResults] = await db.query('SELECT front_id_text, back_id_text FROM kyc WHERE user_id = ?', [user_id]);
    if (!kycResults.length) {
      return res.status(404).json({ error: 'KYC data not found' });
    }

    const { front_id_text, back_id_text } = kycResults[0];

    // Use web3Service to approve KYC on-chain
    const { txHash } = await web3Service.approveKYC(wallet_address, full_name, front_id_text, back_id_text);

    await db.query('UPDATE kyc SET status = "approved" WHERE user_id = ?', [user_id]);
    res.status(200).json({ message: 'KYC approved and stored on-chain', txHash });
  } catch (error) {
    console.error('Approve KYC error:', error.message);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// 8. Fetch Asset Transfers
app.get('/asset-transfers/:wallet_address', verifyToken, async (req, res) => {
  const { wallet_address } = req.params;
  const { from_date, to_date } = req.query;

  if (!wallet_address || !from_date || !to_date) {
    return res.status(400).json({ error: 'Wallet address, from_date, and to_date are required' });
  }

  try {
    const fromDate = new Date(from_date);
    const toDate = new Date(to_date);
    const transfers = await getAssetTransfers(walletAddress, fromDate, toDate);
    res.status(200).json({ transfers: transfers.map((tx) => tx.jsonResponse()) });
  } catch (error) {
    console.error('Asset transfers error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// 9. Forgot Password (Send OTP)
app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const [results] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!results.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // Generate 6-digit OTP
    const otpExpiry = new Date(Date.now() + 10 * 60000); // OTP valid for 10 minutes

    await db.query('UPDATE users SET reset_otp = ?, reset_otp_expiry = ? WHERE email = ?', [otp, otpExpiry, email]);

    const mailOptions = {
      from: process.env.MAIL,
      to: email,
      subject: 'SecureX-ID Password Reset OTP',
      text: `Dear User,\n\nYour OTP for password reset is: ${otp}\n\nThis OTP is valid for 10 minutes. Do not share it with anyone.\n\nBest regards,\nSecureX-ID Team`,
    };

    mailAuth.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('Email error:', error);
        return res.status(500).json({ error: 'Email sending failed' });
      }
      console.log('Email sent:', info.response);
      res.status(200).json({ message: 'OTP sent to your email' });
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// 10. Verify OTP
app.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  try {
    const [results] = await db.query('SELECT * FROM users WHERE email = ? AND reset_otp = ? AND reset_otp_expiry > NOW()', [email, otp]);
    if (!results.length) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    res.status(200).json({ message: 'OTP verified successfully' });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// 11. Reset Password
app.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) {
    return res.status(400).json({ error: 'Email, OTP, and new password are required' });
  }

  try {
    // Verify OTP first
    const [results] = await db.query('SELECT * FROM users WHERE email = ? AND reset_otp = ? AND reset_otp_expiry > NOW()', [email, otp]);
    if (!results.length) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and clear OTP fields
    await db.query('UPDATE users SET password = ?, reset_otp = NULL, reset_otp_expiry = NULL WHERE email = ?', [hashedPassword, email]);

    res.status(200).json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});
// 12. Get All Users (Admin Only)
app.get('/admin/users', verifyToken, async (req, res) => {
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Access denied. Admins only.' });
  }

  try {
    const [users] = await db.query(`
      SELECT 
        u.id AS userId,
        u.full_name,
        k.wallet_address,
        k.status AS kycStatus
      FROM users u
      LEFT JOIN kyc k ON u.id = k.user_id
      ORDER BY u.created_at DESC
    `);

    const formattedUsers = users.map(user => ({
      userDetails: {
        id: user.userId,
        fullName: user.full_name,
      },
      kycDetails: {
        walletAddress: user.wallet_address || 'Not submitted',
        status: user.kycStatus || 'not_submitted'
      },
      action: getKycAction(user.kycStatus)
    }));

    res.status(200).json({ users: formattedUsers });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Helper function to determine actions
const getKycAction = (status) => {
  switch (status) {
    case 'pending':
      return { label: 'Review KYC' };
    case 'approved':
      return { label: 'View Details' };
    case 'rejected':
      return { label: 'Re-submit Required' };
    default:
      return { label: 'Submit KYC' };
  }
};


app.post('/users/:userId/approve', authenticate, async (req, res) => {
  try {
      const { userId } = req.params;
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ message: 'User not found' });

      user.kycDetails.status = 'verified';
      await user.save();
      res.json({ message: 'User KYC approved', user });
  } catch (error) {
      res.status(500).json({ message: 'Server error', error });
  }
});

// Reject KYC
app.post('/users/:userId/reject', authenticate, async (req, res) => {
  try {
      const { userId } = req.params;
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ message: 'User not found' });

      user.kycDetails.status = 'rejected';
      await user.save();
      res.json({ message: 'User KYC rejected', user });
  } catch (error) {
      res.status(500).json({ message: 'Server error', error });
  }
});
// Start Server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
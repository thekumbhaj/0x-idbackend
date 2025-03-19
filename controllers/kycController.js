const multer = require('multer');
const { db } = require('../config/db');
const { mailAuth } = require('../services/emailService');
const { approveKYC } = require('../services/web3Service');
const { getAssetTransfers } = require('../services/moralisService');
const { processImage } = require('../services/ocrService');
const { extractAddress } = require('../helpers/ocrHelpers');

// File Upload Setup
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, 'uploads/'),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

const uploadKYCDocuments = async (req, res) => {
  const { user_id, wallet_address } = req.body;
  const files = req.files;

  // Input validation
  if (!user_id || !wallet_address || !files.front_id || !files.back_id || !files.selfie_with_id) {
    return res.status(400).json({ error: 'All fields and files are required' });
  }

  try {
    // Process front and back ID images
    const frontResult = await processImage(req, res, 'front_id');
    console.log('Front ID Result:', frontResult);

    // Process back ID image 
    const backResult = await processImage(req, res, 'back_id');
    console.log('Back ID Result:', backResult);

    // Convert results to expected format
    const frontData = {
      fullName: frontResult.name,
      dob: frontResult.dateOfBirth,
      idNumber: frontResult.aadhaarNumber || frontResult.passportNumber || frontResult.licenseNumber
    };

    const backData = {
      address: extractAddress(backResult.address)
    };

    // Set raw text
    const frontText = frontResult.fullText;
    const backText = backResult.fullText;

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
};

const getKYCStatus = async (req, res) => {
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
};

const updateKYCStatus = async (req, res) => {
    const { user_id, status } = req.body;

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
};

const approveKYCOnChain = async (req, res) => {
    const { user_id } = req.body;

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
        const { txHash } = await approveKYC(wallet_address, full_name, front_id_text, back_id_text);

        await db.query('UPDATE kyc SET status = "approved" WHERE user_id = ?', [user_id]);
        res.status(200).json({ message: 'KYC approved and stored on-chain', txHash });
    } catch (error) {
        console.error('Approve KYC error:', error.message);
        res.status(500).json({ error: 'Server error', details: error.message });
    }
};

const getAssetTransfersRoute = async (req, res) => {
    const { wallet_address } = req.params;
    const { from_date, to_date } = req.query;

    if (!wallet_address || !from_date || !to_date) {
        return res.status(400).json({ error: 'Wallet address, from_date, and to_date are required' });
    }

    try {
        const fromDate = new Date(from_date);
        const toDate = new Date(to_date);
        const transfers = await getAssetTransfers(wallet_address, fromDate, toDate);
        res.status(200).json({ transfers: transfers.map((tx) => tx.jsonResponse()) });
    } catch (error) {
        console.error('Asset transfers error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};


module.exports = { uploadKYCDocuments, getKYCStatus, updateKYCStatus, approveKYCOnChain, getAssetTransfersRoute, upload };
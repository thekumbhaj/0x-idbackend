const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../config/db');
const { sendSecuredappOTPMail } = require('../services/emailService');

const signup = async (req, res) => {
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
};

const verifyOTP = async (req, res) => {
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
};

const login = async (req, res) => {
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
};

const forgotPassword = async (req, res) => {
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

      // Import mailAuth from emailService
      const { mailAuth } = require('../services/emailService');

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
};

const resetPassword = async (req, res) => {
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
};

module.exports = { signup, verifyOTP, login, forgotPassword, resetPassword };
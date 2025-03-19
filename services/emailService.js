const nodemailer = require('nodemailer');

const mailAuth = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.MAIL, pass: process.env.MAIL_PASSWORD },
});

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

module.exports = { sendSecuredappOTPMail, mailAuth }; // Export mailAuth for use in other modules
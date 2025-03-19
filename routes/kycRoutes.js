const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');
const { uploadKYCDocuments, getKYCStatus, updateKYCStatus, approveKYCOnChain, getAssetTransfersRoute, upload } = require('../controllers/kycController');


router.post(
    '/upload-kyc',
    verifyToken,
    upload.fields([
        { name: 'front_id', maxCount: 1 },
        { name: 'back_id', maxCount: 1 },
        { name: 'selfie_with_id', maxCount: 1 }
    ]),
    uploadKYCDocuments
);
router.get('/kyc-status/:user_id', verifyToken, getKYCStatus);
router.post('/update-kyc-status', verifyToken, updateKYCStatus);
router.post('/approve-kyc', verifyToken, approveKYCOnChain);
router.get('/asset-transfers/:wallet_address', verifyToken, getAssetTransfersRoute);

module.exports = router;
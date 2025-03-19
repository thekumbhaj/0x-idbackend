const tesseract = require('node-tesseract-ocr');
const fs = require('fs');
const {
    extractAadhaarInfo,
    extractPassportInfo,
    extractDLInfo,
    detectDocumentType
} = require('../helpers/ocrHelpers'); // Import helpers

exports.processImage = async (req, res, fileType) => {
    let filePath;

    if (req.files && req.files[fileType] && req.files[fileType][0] && req.files[fileType][0].path) {
        filePath = req.files[fileType][0].path;
    } else {
        console.error('No file uploaded for fileType:', fileType);
        return res.status(400).send('No file uploaded.');
    }

    console.log('Uploaded file path:', filePath);

    if (!fs.existsSync(filePath)) {
        console.error('File does not exist:', filePath);
        return res.status(400).send('File does not exist.');
    }

    const config = {
        lang: 'eng',
        oem: 1,
        psm: 3,
    };

    try {
        const text = await tesseract.recognize(filePath, config);
        console.log('OCR Result:', text);

        const documentType = detectDocumentType(text);
        let extractedInfo;

        switch (documentType) {
            case 'aadhaar':
                extractedInfo = extractAadhaarInfo(text);
                break;
            case 'passport':
                extractedInfo = extractPassportInfo(text);
                break;
            case 'dl':
                extractedInfo = extractDLInfo(text);
                break;
            default:
                extractedInfo = { error: 'Unknown document type', fullText: text };
        }

        // Clean up the temporary file
        fs.unlinkSync(filePath);

        return {
            ...extractedInfo,
            fullText: text // Include full text for debugging
        };
    } catch (err) {
        console.error('Error during OCR processing:', err);
        res.status(500).send('Error processing image.');
    }
};
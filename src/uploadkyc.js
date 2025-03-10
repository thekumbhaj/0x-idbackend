const tesseract = require('node-tesseract-ocr');
const fs = require('fs');

// Add this helper function at the top
const detectSide = (text, documentType) => {
    // Common indicators for each document type
    const indicators = {
        'aadhaar': {
            front: ['government of india', 'आधार', 'aadhaar', 'uid', 'dob', 'date of birth'],
            back: ['address', 'पता', 'मेरा आधार', 'authentication', 'signature', 'address to']
        },
        'dl': {
            front: ['driving licence', 'transport', 'date of birth', 'dob', 'photo'],
            back: ['blood group', 'donor', 'valid', 'address', 'signature', 'authority']
        },
        'passport': {
            front: ['republic of india', 'passport', 'date of birth', 'nationality'],
            back: ['holder\'s signature', 'spouse', 'address', 'file number']
        }
    };

    const lowerText = text.toLowerCase();
    const docIndicators = indicators[documentType] || indicators['aadhaar'];

    // Check for front side indicators
    for (const indicator of docIndicators.front) {
        if (lowerText.includes(indicator.toLowerCase())) {
            return 'Front Side';
        }
    }

    // Check for back side indicators
    for (const indicator of docIndicators.back) {
        if (lowerText.includes(indicator.toLowerCase())) {
            return 'Back Side';
        }
    }

    return 'Unknown Side';
};

// Improve address extraction for Aadhaar back side
const extractAddress = (text, documentType) => {
    const addressPatterns = {
        'aadhaar': [
            // Complete address pattern with optional S/O and door number
            /(?:Address\s*:\s*(?:S\/O:?[^,]*,)?\s*(?:\d+\/\d+)?.*?)(?=help@|uidai\.gov\.in|$)/i,
            // Pattern for S/O with address
            /S\/O:?\s*[^,]+,\s*(?:\d+\/\d+)?.*?(?=help@|uidai\.gov\.in|$)/i,
            // Pattern for direct address with door number
            /(?:\d+\/\d+)[^]*?(?=help@|uidai\.gov\.in|$)/i
        ],
        'dl': [
            /(?:Address|पता)[\s:]+([^\n]+(?:\n[^\n]+)*?)(?=\n\s*\n|\n[A-Z]|$)/i,
            /(?:Permanent\s+Address|Present\s+Address)[\s:]+([^\n]+(?:\n[^\n]+)*?)(?=\n\s*\n|\n[A-Z]|$)/i
        ]
    };

    const patterns = addressPatterns[documentType] || [];
    let address = null;

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && (match[1] || match[0])) {
            // Clean up the extracted address
            let extractedAddress = (match[1] || match[0])
                .replace(/(?:Address\s*:|पता\s*:|[Cc]\/[Oo]\s*:|S\/O\s*:|D\/O\s*:|W\/O\s*:)/ig, '')
                .replace(/\r\n/g, ', ')
                .replace(/\n/g, ', ')
                .replace(/,\s*,/g, ',')
                .replace(/\s+/g, ' ')
                .replace(/,\s*$/, '')
                .trim();

            // Split by commas and clean each part
            const addressParts = extractedAddress
                .split(',')
                .map(part => part.trim())
                .filter(part => (
                    part && 
                    !part.match(/help@|uidai\.gov\.in/) && 
                    part.length > 1
                ));

            // Rejoin with proper formatting
            address = addressParts.join(', ');
            
            if (address) break;
        }
    }

    return address;
};

// Helper functions for document-specific extraction
const extractAadhaarInfo = (text) => {
    // Improved name patterns for Aadhaar
    const namePatterns = [
        /(?<=नाम\s*:|Name\s*:)([^\n]*?)(?=\n|DOB|Year|जन्म|Date)/is,
        /(?<=To:)([^\n]*?)(?=\n|S\/O|D\/O)/is,
        /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*(?=\d{4}\s\d{4}\s\d{4})/,
        /^([A-Z][a-z]*(?:\s+[A-Z])?[a-z]*)\s*$/m,  // Single name with optional initial
        /([A-Z][a-z]+\s+[A-Z])\s*(?=\n|DOB|\d{4})/,  // Name with initial at end
        /(?:\n|^)([A-Z][a-z]+\s+[A-Z]\.?)\s*(?=\n|DOB)/m  // Name with dot initial
    ];

    let name = null;
    // First try to find name near DOB
    const dobLine = text.split('\n').find(line => line.includes('DOB:'));
    if (dobLine) {
        const beforeDOB = text.substring(0, text.indexOf(dobLine));
        const lines = beforeDOB.split('\n');
        // Look for name in last non-empty line before DOB
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line && !line.includes('GOVERNMENT') && !line.includes('INDIA')) {
                name = line;
                break;
            }
        }
    }

    // If name not found near DOB, try patterns
    if (!name) {
        for (let pattern of namePatterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
                name = match[1].trim();
                break;
            }
        }
    }

    const side = detectSide(text, 'aadhaar');
    const address = side === 'Back Side' ? extractAddress(text, 'aadhaar') : null;

    return {
        documentType: 'Aadhaar Card',
        side: side,
        aadhaarNumber: (text.match(/\d{4}\s\d{4}\s\d{4}/) || [null])[0],
        name: name,
        dateOfBirth: (text.match(/(?<=DOB\s*:|Date of Birth\s*:|जन्म\s*:).*?(?=\n|MALE|FEMALE)/is) || [null])[0]?.trim(),
        gender: (text.match(/MALE|FEMALE/i) || [null])[0],
        address: address,
        isBackSide: side === 'Back Side'
    };
};

const extractPassportInfo = (text) => {
    const namePatterns = [
        /(?<=Given Name\s*:|Name\s*:)([^\n]*?)(?=\n|Surname|DOB)/is,
        /(?<=Surname\s*:)([^\n]*?)(?=\n|Given)/is,
        /(?<=Name:\s*)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/
    ];

    let name = null;
    for (let pattern of namePatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            name = match[1].trim();
            break;
        }
    }

    return {
        documentType: 'Passport',
        side: detectSide(text, 'passport'),
        passportNumber: (text.match(/[A-Z][0-9]{7}/) || [null])[0],
        name: name,
        dateOfBirth: (text.match(/(?<=Date of Birth\s*:|DOB\s*:).*?(?=\n|Sex|Gender)/is) || [null])[0]?.trim(),
        nationality: (text.match(/(?<=Nationality\s*:).*?(?=\n)/is) || [null])[0]?.trim()
    };
};

const extractDLInfo = (text) => {
    // Name patterns remain the same
    const namePatterns = [
        /([A-Z]\.[A-Z]+[A-Za-z]+)/,  // Matches N.KEERTHIVELAN
        /(?<=\n)([A-Z]\.[A-Z]+[A-Za-z]+)(?=\r\n|\n)/,  // Name on its own line
        /([A-Z]+\s*[A-Z]+[a-z]+)/    // Regular name format
    ];

    let name = null;
    for (let pattern of namePatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            name = match[1].trim();
            break;
        }
    }

    // Improved license number extraction
    const lines = text.split('\n');
    const licenseNumber = lines.find(line => 
        line.match(/[A-Z]{2}\d{2}[A-Z0-9]\d{7,}/))
        ?.match(/[A-Z]{2}\d{2}[A-Z0-9]\d{7,}/)?.[0] || null;

    // Enhanced DOB extraction patterns
    const dates = text.match(/\d{2}[-/]\d{2}[-/]\d{4}/g) || [];
    let dob = null;
    
    // Look for date near "Birth" or "DOB" keywords
    const birthLines = lines.filter(line => 
        line.toLowerCase().includes('birth') || 
        line.toLowerCase().includes('dob'));
    
    for (const line of birthLines) {
        const dateMatch = line.match(/\d{2}[-/]\d{2}[-/]\d{4}/);
        if (dateMatch) {
            dob = dateMatch[0];
            break;
        }
    }

    // If no date found near keywords, look for dates in sequence
    if (!dob && dates.length > 0) {
        // In DL, DOB is usually the first or second date
        dob = dates[1] || dates[0];
    }

    // Extract valid until date (usually the last date in the document)
    let validUntil = null;
    if (dates.length > 0) {
        validUntil = dates[dates.length - 1];
    }

    const side = detectSide(text, 'dl');
    const address = side === 'Front Side' ? extractAddress(text, 'dl') : null;

    return {
        documentType: 'Driving License',
        side: side,
        licenseNumber: licenseNumber,
        name: name,
        dateOfBirth: dob,
        validUntil: validUntil,
        address: address
    };
};

const detectDocumentType = (text) => {
    const lowerText = text.toLowerCase();
    
    // Check for Aadhaar first (improved detection)
    if (text.match(/\d{4}\s\d{4}\s\d{4}/) || 
        lowerText.includes('aadhaar') ||
        lowerText.includes('uid') ||
        // Add back side specific patterns
        lowerText.includes('help@uidai.gov.in') ||
        lowerText.includes('mera aadhaar') ||
        lowerText.includes('address:') ||
        (lowerText.includes('s/o:') && lowerText.includes('address')) ||
        lowerText.includes('uidai.gov.in')) {
        return 'aadhaar';
    }
    
    // Rest of the document type checks
    if (lowerText.includes('driving licence') || 
        lowerText.includes('driving license') || 
        text.match(/[A-Z]{2}\d{2}[A-Z0-9]\d{7,}/)) {
        return 'dl';
    }
    
    if (lowerText.includes('passport')) {
        return 'passport';
    }
    
    return 'unknown';
};

exports.processImage = async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    console.log('Uploaded file path:', req.file.path);

    if (!fs.existsSync(req.file.path)) {
        console.error('File does not exist:', req.file.path);
        return res.status(400).send('File does not exist.');
    }

    const config = {
        lang: 'eng',
        oem: 1,
        psm: 3,
    };

    try {
        const text = await tesseract.recognize(req.file.path, config);
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
        fs.unlinkSync(req.file.path);

        res.json({
            ...extractedInfo,
            fullText: text // Include full text for debugging
        });
    } catch (err) {
        console.error('Error during OCR processing:', err);
        res.status(500).send('Error processing image.');
    }
};
const { db } = require('../config/db');

const getAllUsers = async (req, res) => {
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
};

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

module.exports = { getAllUsers };
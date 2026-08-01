const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'lms-secret-key-12345';

const verifyToken = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Akses ditolak. Token tidak ditemukan.' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        
        req.user = decoded; // Decoded payload contains { id, username, role, schoolCode, etc. }
        next();
    } catch (err) {
        console.error('JWT Verification Error:', err.message);
        return res.status(401).json({ error: 'Token tidak valid atau telah kedaluwarsa.' });
    }
};

const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !req.user.role) {
            return res.status(401).json({ error: 'Pengguna tidak terautentikasi.' });
        }

        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Akses dilarang. Anda tidak memiliki izin untuk mengakses rute ini.' });
        }

        next();
    };
};

module.exports = {
    verifyToken,
    authorizeRoles
};

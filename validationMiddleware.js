const { body, validationResult } = require('express-validator');

// Helper to handle validation errors and return structured field errors
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (errors.isEmpty()) {
        return next();
    }
    
    // Map the first validation error to the frontend field format
    const firstError = errors.array()[0];
    return res.status(400).json({
        error: firstError.msg,
        field: firstError.path // express-validator v7 uses 'path' to denote the invalid field
    });
};

const validateTeacherLogin = [
    body('schoolCode')
        .trim()
        .notEmpty().withMessage('Kode sekolah wajib diisi.')
        .isAlphanumeric().withMessage('Kode sekolah hanya boleh mengandung huruf dan angka.'),
    body('email')
        .trim()
        .notEmpty().withMessage('Email atau Username wajib diisi.'),
    body('password')
        .notEmpty().withMessage('Password wajib diisi.'),
    validate
];

const validateStudentLogin = [
    body('schoolCode')
        .trim()
        .notEmpty().withMessage('Kode sekolah wajib diisi.')
        .isAlphanumeric().withMessage('Kode sekolah hanya boleh mengandung huruf dan angka.'),
    body('username')
        .trim()
        .notEmpty().withMessage('Username/NISN wajib diisi.'),
    body('password')
        .notEmpty().withMessage('Password wajib diisi.'),
    validate
];

const validateHeadmasterLogin = [
    body('npsn')
        .trim()
        .notEmpty().withMessage('NPSN wajib diisi.')
        .isNumeric().withMessage('NPSN harus berupa angka.')
        .isLength({ min: 8, max: 8 }).withMessage('NPSN harus berupa 8 digit angka.'),
    body('password')
        .notEmpty().withMessage('Password wajib diisi.'),
    validate
];

const validateRegister = [
    body('role')
        .trim()
        .notEmpty().withMessage('Role wajib diisi.')
        .isIn(['student', 'teacher', 'headmaster']).withMessage('Role tidak valid.'),
    body('name')
        .trim()
        .notEmpty().withMessage('Nama wajib diisi.')
        .isLength({ min: 3 }).withMessage('Nama minimal harus 3 karakter.'),
    body('email')
        .trim()
        .notEmpty().withMessage('Email wajib diisi.')
        .isEmail().withMessage('Format email tidak valid.'),
    body('password')
        .notEmpty().withMessage('Password wajib diisi.')
        .isLength({ min: 6 }).withMessage('Password minimal harus 6 karakter.'),
    validate
];

const validateCourse = [
    body('code')
        .trim()
        .notEmpty().withMessage('Kode mata pelajaran wajib diisi.')
        .custom(value => {
            // Allow alphanumeric, dash and underscore
            if (!/^[a-zA-Z0-9\-_]+$/.test(value)) {
                throw new Error('Kode mata pelajaran hanya boleh huruf, angka, dash (-), atau underscore (_).');
            }
            return true;
        }),
    body('name')
        .trim()
        .notEmpty().withMessage('Nama mata pelajaran wajib diisi.')
        .isLength({ min: 3 }).withMessage('Nama mata pelajaran minimal 3 karakter.'),
    body('grade_level')
        .optional({ checkFalsy: true })
        .trim()
        .isLength({ max: 20 }).withMessage('Tingkat kelas maksimal 20 karakter.'),
    validate
];

module.exports = {
    validateTeacherLogin,
    validateStudentLogin,
    validateHeadmasterLogin,
    validateRegister,
    validateCourse
};

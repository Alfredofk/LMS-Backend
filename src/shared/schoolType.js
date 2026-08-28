'use strict';

/**
 * National curriculum facts, not school preferences.
 *
 * These are hardcoded deliberately. A school able to edit its own grade range or
 * phase boundaries could only misconfigure itself, and cross-school reporting
 * depends on this spine being identical everywhere.
 *
 * "School type" is the Indonesian `jenjang`. It is NOT called a "level" anywhere
 * in this codebase, because that word is already taken by grade level.
 *
 * Phase boundaries are Kurikulum Merdeka's: A=1-2, B=3-4, C=5-6, D=7-9, E=10, F=11-12.
 * Academic streaming (IPA/IPS) is deliberately absent - Kurikulum Merdeka abolished it.
 */

const SCHOOL_TYPES = {
    SD: { minGrade: 1, maxGrade: 6, defaultDurationYears: 6 },
    SMP: { minGrade: 7, maxGrade: 9, defaultDurationYears: 3 },
    SMA: { minGrade: 10, maxGrade: 12, defaultDurationYears: 3 },
    // The only genuinely varying part: most SMK run 3 years, some programs run 4.
    SMK: {
        minGrade: 10,
        maxGrade: 12,
        defaultDurationYears: 3,
        allowedDurationYears: [3, 4],
    },
};

const PHASE_BY_GRADE = {
    1: 'A',
    2: 'A',
    3: 'B',
    4: 'B',
    5: 'C',
    6: 'C',
    7: 'D',
    8: 'D',
    9: 'D',
    10: 'E',
    11: 'F',
    12: 'F',
    13: 'F',
};

const isSchoolType = (schoolType) =>
    Object.prototype.hasOwnProperty.call(SCHOOL_TYPES, schoolType);

function specFor(schoolType) {
    const spec = SCHOOL_TYPES[schoolType];
    if (!spec) throw new Error(`Unknown school type: ${schoolType}`);
    return spec;
}

/** The highest grade this school teaches. A four-year SMK runs to 13. */
function maxGradeFor(schoolType, durationYears) {
    const spec = specFor(schoolType);
    if (schoolType === 'SMK' && durationYears === 4) return 13;
    return spec.maxGrade;
}

function gradeRangeFor(schoolType, durationYears) {
    const spec = specFor(schoolType);
    return { min: spec.minGrade, max: maxGradeFor(schoolType, durationYears) };
}

function isValidGrade(schoolType, gradeLevel, durationYears) {
    const { min, max } = gradeRangeFor(schoolType, durationYears);
    return Number.isInteger(gradeLevel) && gradeLevel >= min && gradeLevel <= max;
}

/** Phase is derived from the grade, never stored as a school setting. */
function phaseFor(gradeLevel) {
    const phase = PHASE_BY_GRADE[gradeLevel];
    if (!phase) throw new Error(`No phase defined for grade level ${gradeLevel}`);
    return phase;
}

/** True when finishing this grade means graduating rather than advancing. */
function isFinalGrade(schoolType, gradeLevel, durationYears) {
    return gradeLevel === maxGradeFor(schoolType, durationYears);
}

/**
 * Where a student lands next year, given their promotion outcome.
 * Null means they leave the school: they either graduated or ran out of grades.
 */
function nextGradeLevel(schoolType, gradeLevel, outcome, durationYears) {
    switch (outcome) {
        case 'PROMOTED':
            return isFinalGrade(schoolType, gradeLevel, durationYears)
                ? null
                : gradeLevel + 1;
        case 'RETAINED':
            return gradeLevel;
        case 'GRADUATED':
            return null;
        default:
            throw new Error(`Unknown promotion outcome: ${outcome}`);
    }
}

function isValidDurationYears(schoolType, durationYears) {
    const spec = SCHOOL_TYPES[schoolType];
    if (!spec) return false;
    const allowed = spec.allowedDurationYears ?? [spec.defaultDurationYears];
    return allowed.includes(durationYears);
}

module.exports = {
    SCHOOL_TYPES,
    SCHOOL_TYPE_NAMES: Object.keys(SCHOOL_TYPES),
    isSchoolType,
    gradeRangeFor,
    maxGradeFor,
    isValidGrade,
    phaseFor,
    isFinalGrade,
    nextGradeLevel,
    isValidDurationYears,
};

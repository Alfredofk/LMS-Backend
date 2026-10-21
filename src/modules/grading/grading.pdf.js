import PDFDocument from 'pdfkit';

// The printed Report Card (grading-and-report-card ticket 07): a pure function from a
// Report Card's view (reportCardView in grading.reportCards.js) to the bytes of its PDF.
// It reads nothing and imports nothing of the module, so the transfer document
// (registration-and-membership ticket 15) can reuse its parts.
//
// Owner's decisions (2026-10-13, the spec, and the plan of 2026-10-20):
// - pdfkit, no headless browser (handoff #32). Rendered on request from a frozen
//   version and never stored: its creation date is the version's writtenAt, so the same
//   version always gives the same document.
// - A4 portrait. The printed labels are Indonesian, the words CONTEXT.md gives: this is
//   the school's official rapor, signed and handed to the family.
// - The standard PDF font, with no font file: it holds every Latin letter Indonesian
//   uses. A character outside its set (WinAnsi) prints as '?' - pdfkit writes each
//   character as a bare hex code, so one beyond a byte would garble its neighbours.
// - An empty name or NIP prints as a dotted line to sign or fill by hand, an empty
//   Description as '-'.
//
// The fuller print (ticket 08, owner 2026-10-20):
// - The title "LAPORAN HASIL BELAJAR PESERTA DIDIK".
// - Each Subject's Tugas, Kuis, UTS and UAS beside its Final Grade, KKTP and letter, and
//   its Description on a row of its own below them; '-' for a type that is no part of
//   the grade.
// - Blank Extracurricular and Personality tables, when the School chose them at close,
//   to fill in by hand: five rows each, nothing printed in them but their number, the
//   Personality table's aspects written in by hand too (owner, 2026-10-21). The absences
//   as a table; the grading system low on the page, after the Note (owner, 2026-10-20).
// - The signature block is never split across pages: the room it needs is measured by
//   the same code that draws it, long names that wrap included. Ticket 07 reserved a
//   fixed 190 pt for the 226 it drew.
//
// The letterhead (ticket 10, owner 2026-10-20): above the title, the School's name in
// capitals, its address and its phone as frozen at close, and its logo on the left; with
// no logo the text is centred alone. The text stays centred on the page, and sits at the
// middle of the logo's height (owner, 2026-10-21). Under it a double rule. The logo's
// bytes come beside the view, never in it: what was frozen is a storage key, read by the
// caller.
//
// The Promotion Outcome (ticket 09, owner 2026-10-20): an even Semester's says, just above
// the signatures and on their page, what the year decided - "Naik ke kelas VIII
// (Delapan)", "Tinggal di kelas VII (Tujuh)" or "Lulus". It names the grade level, never
// a Class: next year's Classes come only with Rollover.

const MARGIN = 50;
// Room under the content for each page's footer.
const FOOTER_ROOM = 30;
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const SIZE = 10;
const TABLE_SIZE = 9;
const FOOTER_SIZE = 8;
const PAD = 4;
const LABEL_WIDTH = 100;
const BLANK = '..............................';
const SHADE = '#e8e8e8';
// Space between a section's title and what follows it.
const TITLE_GAP = 4;
// The least height of a row left blank to write in by hand.
const BLANK_ROW_HEIGHT = 20;
// The space left to sign in, from the top of a signature column to the name.
const SIGNING_ROOM = 80;
const SIGNATURE_WIDTH = 200;
// Between the Guardian's and the Homeroom Teacher's row and the Principal's.
const SIGNATURE_GAP = 20;

const TITLE = 'LAPORAN HASIL BELAJAR PESERTA DIDIK';

// The letterhead's logo box, square, and the room between it and the text.
const LOGO_BOX = 64;
const LOGO_GAP = 12;

// The type averages' columns, keyed as the view's types are.
const TYPE_COLUMNS = [
    ['TUGAS', 'Tugas'],
    ['KUIS', 'Kuis'],
    ['UTS', 'UTS'],
    ['UAS', 'UAS'],
];

// The Subjects' table. A column without a width takes the rest of the page's.
const GRADE_COLUMNS = [
    { label: 'No', width: 24, align: 'center' },
    { label: 'Mata Pelajaran', width: null, align: 'left' },
    ...TYPE_COLUMNS.map(([, label]) => ({ label, width: 36, align: 'center' })),
    { label: 'Nilai Akhir', width: 44, align: 'center' },
    { label: 'KKTP', width: 36, align: 'center' },
    { label: 'Huruf', width: 38, align: 'center' },
];

const EXTRACURRICULAR_COLUMNS = [
    { label: 'No', width: 24, align: 'center' },
    { label: 'Ekstrakurikuler', width: 180, align: 'left' },
    { label: 'Nilai', width: 60, align: 'center' },
    { label: 'Keterangan', width: null, align: 'left' },
];

const PERSONALITY_COLUMNS = [
    { label: 'No', width: 24, align: 'center' },
    { label: 'Aspek', width: 180, align: 'left' },
    { label: 'Nilai', width: 60, align: 'center' },
    { label: 'Keterangan', width: null, align: 'left' },
];

// The rows of either blank table: five, numbered, the rest left to fill in by hand. The
// Personality table printed four aspects of its own until the owner chose blank rows
// (owner, 2026-10-21).
const BLANK_ROWS = Array.from({ length: 5 }, (_, index) => [String(index + 1), '', '', '']);

// The absences, a table with no header.
const ABSENCE_COLUMNS = [
    { label: null, width: 120, align: 'left' },
    { label: null, width: 100, align: 'left' },
];

const PROMOTION_LEAD = 'Berdasarkan hasil yang dicapai pada semester 1 dan 2, peserta didik ditetapkan:';
// Between the statement and the signatures below it.
const PROMOTION_GAP = 16;

// A grade level as a rapor writes it: its Roman numeral and its name, to 13 (a
// four-year SMK).
const GRADE_NAMES = {
    1: 'I (Satu)',
    2: 'II (Dua)',
    3: 'III (Tiga)',
    4: 'IV (Empat)',
    5: 'V (Lima)',
    6: 'VI (Enam)',
    7: 'VII (Tujuh)',
    8: 'VIII (Delapan)',
    9: 'IX (Sembilan)',
    10: 'X (Sepuluh)',
    11: 'XI (Sebelas)',
    12: 'XII (Dua Belas)',
    13: 'XIII (Tiga Belas)',
};

// What the year decided, in words.
const PROMOTION_TEXTS = {
    PROMOTED: (grade) => `Naik ke kelas ${grade}`,
    RETAINED: (grade) => `Tinggal di kelas ${grade}`,
    GRADUATED: () => 'Lulus',
};

const GRADING_SYSTEM_NOTE =
    'Nilai Akhir adalah rata-rata berbobot nilai Tugas, Kuis, UTS dan UAS; bobotnya ditetapkan per mata ' +
    'pelajaran, dan jenis bertanda - tidak ikut dihitung. KKTP (Kriteria Ketercapaian Tujuan Pembelajaran) ' +
    'adalah batas ketuntasan.';

const MONTHS = [
    'Januari',
    'Februari',
    'Maret',
    'April',
    'Mei',
    'Juni',
    'Juli',
    'Agustus',
    'September',
    'Oktober',
    'November',
    'Desember',
];

const SEMESTER_NAMES = { 1: '1 (Ganjil)', 2: '2 (Genap)' };

// WinAnsi beyond Latin-1: pdfkit's own map of the dashes, quotes, the euro and the rest.
const WIN_ANSI_EXTRA = new Set([
    0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc, 0x2013, 0x2014, 0x2018, 0x2019,
    0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]);

const isPrintable = (code) =>
    (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(code);

// Text as the standard font prints it: a tab as a space, line breaks kept, any other
// character outside WinAnsi as '?'. Null or empty as the fallback given.
function printable(value, fallback = '-') {
    const text = value === null || value === undefined ? '' : String(value).replace(/\r\n?/g, '\n');
    if (text.trim() === '') return fallback;
    return Array.from(text, (char) => {
        if (char === '\n') return char;
        if (char === '\t') return ' ';
        return isPrintable(char.codePointAt(0)) ? char : '?';
    }).join('');
}

// '2026-10-17' as '17 Oktober 2026'.
function longDate(day) {
    const [year, month, date] = day.split('-').map(Number);
    return `${date} ${MONTHS[month - 1]} ${year}`;
}

const contentWidth = (doc) => doc.page.width - 2 * MARGIN;
const bottomOf = (doc) => doc.page.height - doc.page.margins.bottom;

// A new page unless this much room is left on this one.
function ensureRoom(doc, height) {
    if (doc.y + height > bottomOf(doc)) doc.addPage();
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

// Each column's width: the fixed ones as given, the one without a width taking the rest.
function laidOut(doc, columns) {
    const fixed = columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
    return columns.map((column) => ({ ...column, width: column.width ?? contentWidth(doc) - fixed }));
}

// The height of a row of cells in these columns, padded, and at least minHeight.
function rowHeightOf(doc, cells, columns, { bold = false, minHeight = 0 } = {}) {
    doc.font(bold ? BOLD : FONT).fontSize(TABLE_SIZE);
    const heights = cells.map((text, index) =>
        text === '' ? 0 : doc.heightOfString(text, { width: columns[index].width - 2 * PAD })
    );
    return Math.max(minHeight, Math.max(...heights) + 2 * PAD);
}

// A row of cells drawn from x at top, each boxed - shaded for a header - with its text
// wrapped inside.
function drawRow(doc, cells, columns, x, top, height, { bold = false, shaded = false } = {}) {
    doc.font(bold ? BOLD : FONT).fontSize(TABLE_SIZE);
    let left = x;
    cells.forEach((text, index) => {
        const { width, align } = columns[index];
        const box = doc.rect(left, top, width, height);
        if (shaded) box.fillAndStroke(SHADE, '#000000');
        else box.stroke();
        doc.fillColor('#000000');
        if (text !== '') doc.text(text, left + PAD, top + PAD, { width: width - 2 * PAD, align });
        left += width;
    });
}

// One row at the current y; a row that does not fit goes to a new page, after the
// header given.
function tableRow(doc, cells, columns, { bold = false, shaded = false, header = null, minHeight = 0 } = {}) {
    const height = rowHeightOf(doc, cells, columns, { bold, minHeight });
    if (doc.y + height > bottomOf(doc)) {
        doc.addPage();
        if (header) header();
    }
    const top = doc.y;
    drawRow(doc, cells, columns, MARGIN, top, height, { bold, shaded });
    doc.x = MARGIN;
    doc.y = top + height;
}

const titleHeight = (doc, title) =>
    doc.font(BOLD).fontSize(SIZE).heightOfString(title, { width: contentWidth(doc) }) + TITLE_GAP;

// A section's bold title at the current y.
function titleOf(doc, title) {
    doc.font(BOLD).fontSize(SIZE).text(title, MARGIN, doc.y, { width: contentWidth(doc) });
    doc.y += TITLE_GAP;
}

// A titled table, short enough to keep whole on one page: its header when its columns
// have labels, its rows - a blank one is room to write in by hand - and a note below it.
function titledTable(doc, title, columns, rows, { minHeight = 0, note = null } = {}) {
    const laid = laidOut(doc, columns);
    const labels = laid.some((column) => column.label) ? laid.map((column) => column.label) : null;
    doc.font(FONT).fontSize(TABLE_SIZE);
    const noteHeight = note ? doc.heightOfString(note, { width: contentWidth(doc) }) : 0;
    const height =
        titleHeight(doc, title) +
        (labels ? rowHeightOf(doc, labels, laid, { bold: true }) : 0) +
        rows.reduce((sum, cells) => sum + rowHeightOf(doc, cells, laid, { minHeight }), 0) +
        (note ? TITLE_GAP + noteHeight : 0);
    doc.moveDown(1);
    ensureRoom(doc, height);
    titleOf(doc, title);
    if (labels) tableRow(doc, labels, laid, { bold: true, shaded: true });
    for (const cells of rows) tableRow(doc, cells, laid, { minHeight });
    if (note) {
        doc.y += TITLE_GAP;
        doc.font(FONT).fontSize(TABLE_SIZE).text(note, MARGIN, doc.y, { width: contentWidth(doc) });
    }
}

// ---------------------------------------------------------------------------
// The parts
// ---------------------------------------------------------------------------

// The School's letterhead at the top of the first page: the logo in its box on the
// left, if there is one, and the name, address and phone centred on the page beside it,
// kept clear of the box on both sides; then a double rule. The shorter of the two sits
// at the middle of the taller: the text beside the logo, or the logo beside a long
// address that wraps (owner, 2026-10-21).
function letterhead(doc, view, logo) {
    const inset = logo ? LOGO_BOX + LOGO_GAP : 0;
    const options = { width: contentWidth(doc) - 2 * inset, align: 'center' };
    const x = MARGIN + inset;
    const name = printable(view.school.name).toUpperCase();
    const lines = [];
    if (view.school.address) lines.push(printable(view.school.address));
    if (view.school.phone) lines.push(`Telp. ${printable(view.school.phone)}`);
    const nameHeight = doc.font(BOLD).fontSize(14).heightOfString(name, options);
    doc.font(FONT).fontSize(SIZE);
    const textHeight = lines.reduce((sum, line) => sum + doc.heightOfString(line, options), nameHeight);
    const height = Math.max(textHeight, logo ? LOGO_BOX : 0);

    if (logo) {
        const top = MARGIN + (height - LOGO_BOX) / 2;
        doc.image(logo, MARGIN, top, { fit: [LOGO_BOX, LOGO_BOX], align: 'center', valign: 'center' });
    }
    doc.font(BOLD).fontSize(14).text(name, x, MARGIN + (height - textHeight) / 2, options);
    doc.font(FONT).fontSize(SIZE);
    for (const line of lines) doc.text(line, x, doc.y, options);

    const ruleAt = Math.max(doc.y, MARGIN + height) + 6;
    const right = MARGIN + contentWidth(doc);
    doc.lineWidth(1.5).moveTo(MARGIN, ruleAt).lineTo(right, ruleAt).stroke();
    doc.lineWidth(0.5).moveTo(MARGIN, ruleAt + 3).lineTo(right, ruleAt + 3).stroke();
    doc.lineWidth(1);
    doc.x = MARGIN;
    doc.y = ruleAt + 14;
}

function heading(doc) {
    doc.font(BOLD).fontSize(14).text(TITLE, MARGIN, doc.y, { width: contentWidth(doc), align: 'center' });
    doc.moveDown(1.2);
}

// One 'label : value' at x, y within width; answers its height.
function field(doc, x, y, width, label, value) {
    const valueWidth = width - LABEL_WIDTH - 18;
    const text = printable(value);
    doc.text(label, x, y, { width: LABEL_WIDTH, lineBreak: false });
    doc.text(':', x + LABEL_WIDTH, y, { lineBreak: false });
    doc.text(text, x + LABEL_WIDTH + 8, y, { width: valueWidth });
    return doc.heightOfString(text, { width: valueWidth });
}

// The Student, the School and the Semester, in two columns.
function identity(doc, view) {
    const half = contentWidth(doc) / 2;
    const rows = [
        [['Nama Peserta Didik', view.student.fullName], ['Kelas', view.class.name]],
        [['NISN', view.student.nisn], ['Fase', view.phase]],
        [['Sekolah', view.school.name], ['Semester', SEMESTER_NAMES[view.semester.ordinal]]],
        [['NPSN', view.school.npsn], ['Tahun Pelajaran', view.academicYear]],
    ];
    doc.font(FONT).fontSize(SIZE);
    for (const pair of rows) {
        const top = doc.y;
        const heights = pair.map(([label, value], index) => field(doc, MARGIN + index * half, top, half, label, value));
        doc.y = top + Math.max(...heights) + 3;
    }
    doc.x = MARGIN;
    doc.moveDown(1);
}

const averageText = (value) => (value === null || value === undefined ? '-' : String(value));

// One Subject: its grades on a row and its Description across the row below, its number
// spanning both. The two never part across pages; the header comes again on a new one.
function subjectRows(doc, number, line, columns, header) {
    const [numberColumn, ...gradeColumns] = columns;
    const grades = [
        printable(line.subject.name),
        ...TYPE_COLUMNS.map(([type]) => averageText(line.types?.[type])),
        String(line.finalGrade),
        String(line.kktp),
        printable(line.letter),
    ];
    const below = [{ width: contentWidth(doc) - numberColumn.width, align: 'left' }];
    const description = [`Deskripsi: ${printable(line.description)}`];
    const gradesHeight = rowHeightOf(doc, grades, gradeColumns);
    const descriptionHeight = rowHeightOf(doc, description, below);
    if (doc.y + gradesHeight + descriptionHeight > bottomOf(doc)) {
        doc.addPage();
        header();
    }
    const top = doc.y;
    const x = MARGIN + numberColumn.width;
    drawRow(doc, [String(number)], [numberColumn], MARGIN, top, gradesHeight + descriptionHeight);
    drawRow(doc, grades, gradeColumns, x, top, gradesHeight);
    drawRow(doc, description, below, x, top + gradesHeight, descriptionHeight);
    doc.x = MARGIN;
    doc.y = top + gradesHeight + descriptionHeight;
}

// The Subjects, the header repeated on every page the table runs onto.
function subjects(doc, view) {
    const columns = laidOut(doc, GRADE_COLUMNS);
    const header = () =>
        tableRow(
            doc,
            columns.map((column) => column.label),
            columns,
            { bold: true, shaded: true }
        );
    ensureRoom(doc, 60);
    header();
    if (view.subjects.length === 0) {
        const whole = laidOut(doc, [{ width: null, align: 'left' }]);
        tableRow(doc, ['Tidak ada mata pelajaran pada semester ini.'], whole, { header });
        return;
    }
    view.subjects.forEach((line, index) => subjectRows(doc, index + 1, line, columns, header));
}

function extracurricular(doc) {
    titledTable(doc, 'Ekstrakurikuler', EXTRACURRICULAR_COLUMNS, BLANK_ROWS, { minHeight: BLANK_ROW_HEIGHT });
}

function personality(doc) {
    titledTable(doc, 'Kepribadian', PERSONALITY_COLUMNS, BLANK_ROWS, { minHeight: BLANK_ROW_HEIGHT });
}

// Absences, counted in Sessions (pertemuan): attendance is kept per Session.
function absences(doc, view) {
    const { sick, excused, absent } = view.attendance;
    const rows = [
        ['Sakit', `${sick} pertemuan`],
        ['Izin', `${excused} pertemuan`],
        ['Alpa', `${absent} pertemuan`],
    ];
    titledTable(doc, 'Ketidakhadiran', ABSENCE_COLUMNS, rows);
}

// A bold title, then the body below it, kept together where it fits.
function section(doc, title, body) {
    doc.moveDown(1);
    const bodyHeight = doc.font(FONT).fontSize(SIZE).heightOfString(body, { width: contentWidth(doc) });
    ensureRoom(doc, titleHeight(doc, title) + Math.min(bodyHeight, 120));
    titleOf(doc, title);
    doc.font(FONT).fontSize(SIZE).text(body, MARGIN, doc.y, { width: contentWidth(doc) });
}

// The letters and the Final Grades each takes, and how the Final Grade is made.
function gradingSystem(doc, view) {
    const columns = [
        { label: 'Huruf', width: 80, align: 'left' },
        ...view.letterScale.map((band) => ({ label: band.letter, width: 50, align: 'center' })),
    ];
    const ranges = ['Nilai Akhir', ...view.letterScale.map((band) => `${band.from}–${band.to}`)];
    titledTable(doc, 'Sistem Penilaian', columns, [ranges], { note: GRADING_SYSTEM_NOTE });
}

// One signature column at x from top: the lines above, room to sign, the name and - but
// for the Guardian's (person undefined) - the NIP. No Guardian is on a Report Card, so
// theirs is a dotted line alone. Drawn, or with draw false only measured: either way it
// answers where the column ends, so the room reserved is the room drawn.
function signature(doc, x, top, above, person, draw) {
    const options = { width: SIGNATURE_WIDTH, align: 'center' };
    if (draw) doc.font(FONT).fontSize(SIZE).text(above.join('\n'), x, top, options);
    const name = person ? printable(person.fullName, BLANK) : BLANK;
    const nameAt = top + SIGNING_ROOM;
    doc.font(BOLD).fontSize(SIZE);
    if (draw) doc.text(name, x, nameAt, options);
    const nipAt = nameAt + doc.heightOfString(name, options);
    if (person === undefined) return nipAt;

    const nip = `NIP. ${person ? printable(person.nip, BLANK) : BLANK}`;
    doc.font(FONT).fontSize(SIZE);
    if (draw) doc.text(nip, x, nipAt, options);
    return nipAt + doc.heightOfString(nip, options);
}

// An even Semester's statement of the year's Promotion Outcome at top: the lead line, then
// the outcome in bold. Drawn, or with draw false only measured; answers its bottom.
function promotionStatement(doc, view, top, draw) {
    const options = { width: contentWidth(doc) };
    const { outcome, nextGradeLevel } = view.promotion;
    const grade = nextGradeLevel === null ? null : (GRADE_NAMES[nextGradeLevel] ?? String(nextGradeLevel));
    const decided = PROMOTION_TEXTS[outcome](grade);
    doc.font(FONT).fontSize(SIZE);
    if (draw) doc.text(PROMOTION_LEAD, MARGIN, top, options);
    const decidedAt = top + doc.heightOfString(PROMOTION_LEAD, options);
    doc.font(BOLD).fontSize(SIZE);
    if (draw) doc.text(decided, MARGIN, decidedAt, options);
    return decidedAt + doc.heightOfString(decided, options);
}

// An even Semester's Promotion Outcome (ticket 09), then the Guardian and the Homeroom
// Teacher side by side and the Principal below them, all on one page.
function signatures(doc, view) {
    const right = MARGIN + contentWidth(doc) - SIGNATURE_WIDTH;
    const middle = MARGIN + (contentWidth(doc) - SIGNATURE_WIDTH) / 2;
    const date = longDate(view.reportDate);
    const placed = view.school.city ? `${printable(view.school.city)}, ${date}` : date;
    // The block from top, drawn or measured: its bottom.
    const block = (top, draw) => {
        const signed = view.promotion ? promotionStatement(doc, view, top, draw) + PROMOTION_GAP : top;
        const guardian = signature(doc, MARGIN, signed, ['', 'Orang Tua/Wali'], undefined, draw);
        const homeroom = signature(doc, right, signed, [placed, 'Wali Kelas'], view.homeroomTeacher, draw);
        const principalAt = Math.max(guardian, homeroom) + SIGNATURE_GAP;
        return signature(doc, middle, principalAt, ['Mengetahui,', 'Kepala Sekolah'], view.principal, draw);
    };
    doc.moveDown(2);
    ensureRoom(doc, block(0, false));
    const top = doc.y;
    doc.y = block(top, true);
    doc.x = MARGIN;
}

// Each page's footer: whose Report Card, which version, and the page of how many.
function footers(doc, view) {
    const { start, count } = doc.bufferedPageRange();
    const who = printable(view.student.fullName).slice(0, 40);
    const what =
        `${who} - NISN ${printable(view.student.nisn)} - Semester ${view.semester.ordinal} ` +
        `${printable(view.academicYear)} - Versi ${view.version}`;
    for (let index = 0; index < count; index += 1) {
        doc.switchToPage(start + index);
        // Below the bottom margin, which pdfkit would otherwise take for a new page.
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const y = doc.page.height - MARGIN;
        doc.font(FONT).fontSize(FOOTER_SIZE).fillColor('#555555');
        doc.text(what, MARGIN, y, { width: contentWidth(doc) - 90, lineBreak: false });
        doc.text(`Halaman ${index + 1} dari ${count}`, MARGIN, y, {
            width: contentWidth(doc),
            align: 'right',
            lineBreak: false,
        });
        doc.fillColor('#000000');
        doc.page.margins.bottom = bottom;
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// The PDF of one Report Card, from its view and its logo's bytes, if it has one, as a
// Buffer.
function renderReportCard(view, { logo = null } = {}) {
    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: MARGIN + FOOTER_ROOM },
        bufferPages: true,
        lang: 'id-ID',
        info: {
            Title: `Rapor ${view.student.fullName} - Semester ${view.semester.ordinal} ${view.academicYear}`,
            Author: view.school.name,
            CreationDate: new Date(view.writtenAt),
        },
    });
    const chunks = [];
    const done = new Promise((resolve, reject) => {
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });

    letterhead(doc, view, logo);
    heading(doc);
    identity(doc, view);
    subjects(doc, view);
    if (view.blankTables?.extracurricular) extracurricular(doc);
    if (view.blankTables?.personality) personality(doc);
    absences(doc, view);
    section(doc, 'Catatan Wali Kelas', printable(view.note));
    gradingSystem(doc, view);
    signatures(doc, view);
    footers(doc, view);
    doc.end();
    return done;
}

export { renderReportCard };

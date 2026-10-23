// The labels under the platform's base domain (governing-body ticket 02): a School's
// by the K9 rule here, a Governing Body's by K13 beside it in ticket 03. Pure: the
// caller says which labels are taken, since uniqueness is the database's.
//
// Only the label is ever built or stored. The base domain is the frontend's
// configuration (owner, 2026-10-21), so nothing here knows it.

// A DNS label's limit.
const MAX_LENGTH = 63;

// What a School, or an admin, may never take: the platform's own hosts and the
// words a person reads as one (owner, 2026-10-21). The generator treats each as
// taken, so a name that would make one gets a tie-break instead.
const RESERVED_SUBDOMAINS = new Set([
    'www', 'api', 'admin', 'app', 'mail', 'auth', 'static', 'cdn', 'ftp',
    'smtp', 'dev', 'staging', 'test', 'docs', 'help', 'support', 'status', 'login',
]);

// A label an admin may set by hand: lowercase letters, digits and inner hyphens.
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// The type's long and short form, stripped from the front of a School's name so the
// type is not written twice: "Sekolah Menengah Atas Penabur 1" and "SMA Penabur 1"
// both give smapenabur1.
const TYPE_FORMS = {
    SD: ['sekolah dasar', 'sd'],
    SMP: ['sekolah menengah pertama', 'smp'],
    SMA: ['sekolah menengah atas', 'sma'],
    SMK: ['sekolah menengah kejuruan', 'smk'],
};

// Lowercase words of letters and digits: accents dropped, the rest a space.
const wordsOf = (text) =>
    (text ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

const isReservedSubdomain = (label) => RESERVED_SUBDOMAINS.has(label);

// The K9 base: the School Type, then the name with the type stripped from its front.
// "Negeri" right after the type becomes "n", as SMAN, SMPN, SDN and SMKN are
// written: "SMA Negeri 1 Malang" gives sman1malang. A short form fused to what
// follows ("SMAN 1 Malang") is stripped as a prefix and leaves its "n" behind,
// to the same end.
function schoolSubdomainBaseOf({ schoolType, name }) {
    const type = schoolType.toLowerCase();
    const [longForm, shortForm] = TYPE_FORMS[schoolType];

    let rest = wordsOf(name);
    if (rest === longForm || rest.startsWith(`${longForm} `)) rest = rest.slice(longForm.length);
    else if (rest.startsWith(shortForm)) rest = rest.slice(shortForm.length);
    rest = rest.trim().replace(/^negeri\b/, 'n');

    return `${type}${rest.replace(/ /g, '')}`.slice(0, MAX_LENGTH);
}

// The K13 base for a Governing Body (ticket 03): the kind's word, then the name with
// that word stripped from its front - "Yayasan Penabur Malang" gives
// yayasanpenaburmalang. A perkumpulan is written `asosiasi` (owner, 2026-10-22: "ganti
// kata lain"), and either word is stripped from its name. A School's base always starts
// sd, smp, sma or smk, so the two rarely meet; uniqueness is checked across both all
// the same.
const KIND_WORDS = {
    FOUNDATION: { word: 'yayasan', stripped: ['yayasan'] },
    ASSOCIATION: { word: 'asosiasi', stripped: ['perkumpulan', 'asosiasi'] },
    GOVERNMENT: { word: 'dinas', stripped: ['dinas'] },
};

function governingBodySubdomainBaseOf({ kind, name }) {
    const { word, stripped } = KIND_WORDS[kind];

    let rest = wordsOf(name);
    const leading = stripped.find((form) => rest === form || rest.startsWith(`${form} `));
    if (leading) rest = rest.slice(leading.length);

    return `${word}${rest.replace(/ /g, '')}`.slice(0, MAX_LENGTH);
}

// Each tie-break's suffix, cut from the base so the label stays within the limit.
const fitted = (base, suffix) => `${base.slice(0, MAX_LENGTH - suffix.length)}${suffix}`;

// The K9 candidates, in order: the base; taken, the city after a hyphen (a number
// added straight on would misread - "smapenabur1" + "2" reads as Penabur 12); still
// taken, a number after that. With no city, the number follows the base. Endless:
// the caller stops at the first one free. A Governing Body's take the same tie-breaks
// (K13), with its address's kota or kabupaten as the city.
function* candidatesFrom(base, cityName) {
    const city = wordsOf(cityName).replace(/ /g, '').slice(0, 24);
    const stem = city ? `-${city}` : '';

    yield base;
    if (stem) yield fitted(base, stem);
    for (let n = 2; ; n += 1) yield fitted(base, `${stem}-${n}`);
}

const schoolSubdomainCandidatesOf = (school) => candidatesFrom(schoolSubdomainBaseOf(school), school.city);

const governingBodySubdomainCandidatesOf = (body) =>
    candidatesFrom(governingBodySubdomainBaseOf(body), body.city);

// A School's subdomain: the first K9 candidate neither reserved nor taken.
function schoolSubdomainOf(school, isTaken) {
    for (const candidate of schoolSubdomainCandidatesOf(school)) {
        if (!isReservedSubdomain(candidate) && !isTaken(candidate)) return candidate;
    }
    throw new Error('unreachable: the candidates never end');
}

export {
    MAX_LENGTH as MAX_SUBDOMAIN_LENGTH,
    RESERVED_SUBDOMAINS,
    SUBDOMAIN_PATTERN,
    isReservedSubdomain,
    schoolSubdomainBaseOf,
    schoolSubdomainCandidatesOf,
    schoolSubdomainOf,
    governingBodySubdomainBaseOf,
    governingBodySubdomainCandidatesOf,
};

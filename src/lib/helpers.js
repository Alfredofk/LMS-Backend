import fs from 'node:fs';
import path from 'node:path';

import { getContext } from '../shared/tenantContext.js';

const TZ = 'Asia/Jakarta';
const LOG_ROOT = path.join(process.cwd(), 'src', 'log');

const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: true,
});

function dateFile() {
    const [year, month, day] = new Date()
        .toLocaleDateString('sv-SE', { timeZone: TZ })
        .split('-');
    return `${day}${month}${year}.txt`;
}

// "SMA Negeri 1 Jakarta" -> "smaNegeri1Jakarta". Drops anything a path cannot hold.
function camelCase(name) {
    const words = String(name).split(/[^a-zA-Z0-9]+/).filter(Boolean);
    return words.map((word, index) =>
        index === 0
            ? word.toLowerCase()
            : word[0].toUpperCase() + word.slice(1).toLowerCase()
    ).join('');
}

function logDir() {
    const context = getContext();
    if (!context?.schoolId) return path.join(LOG_ROOT, 'server');

    // The id suffix keeps two schools with the same name apart.
    const fileName = camelCase(context.schoolName);
    return path.join(LOG_ROOT, `${fileName}-${context.schoolId}`);
}

function stringify(args) {
    return args.map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.stack ?? arg.message;
        try {
            return JSON.stringify(arg);
        } catch {
            return String(arg);
        }
    }).join(' ');
}

function emit (output, name, icon){
    return (...args) => {
        const context = getContext();
        const scope = !context?.schoolId ? `Server` : `${context.schoolName} - ${context.schoolId}`;

        const line = `[${fmt.format(new Date())}] [${scope}] [${name}]${icon} ${stringify(args)}`;
        output(line);

        try {
            const dir = logDir();
            fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(path.join(dir, dateFile()), `${line}\n`, 'utf8');
        } catch (error) {
            console.error('Log Write Failed:', error.message);
        }
    }
}

export function createLogger(name) {
    return {
        log: emit(console.log, name, ''),
        info: emit(console.info, name, ' \u2139\uFE0F'),
        warn: emit(console.warn, name, ' \u26A0\uFE0F'),
        error: emit(console.error, name, ' \u26D4'),
        success: emit(console.log, name, ' \u2705'),
    };
}
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/*
  StorageService: bytes live behind this interface so local disk can be swapped
  for S3 or MinIO without touching callers.

  First user is the KTP upload during school registration. That is a national ID
  document, so the contract includes remove() and callers are expected to use it:
  the file is deleted the moment the platform admin decides, approve or reject.
*/

const root = () => path.resolve(process.env.STORAGE_ROOT ?? './storage');

/*
  Resolve a stored path and refuse anything that escapes the storage root.
  Keys reach us from database columns; treating them as trusted would turn a
  bad row into arbitrary file access.
*/
function resolveKey(key) {
    const base = root();
    const resolved = path.resolve(base, key);
    const relative = path.relative(base, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Storage key escapes the storage root: ${key}`);
    }
    return resolved;
}

function buildKey(folder, originalName) {
    const ext = path.extname(originalName ?? '').slice(0, 10);
    const id = crypto.randomBytes(16).toString('hex');
    return path.posix.join(folder, `${id}${ext}`);
}

const localDriver = {
    async save(buffer, { folder, originalName }) {
        const key = buildKey(folder, originalName);
        const target = resolveKey(key);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, buffer);
        return key;
    },

    async read(key) {
        return fs.readFile(resolveKey(key));
    },

    async exists(key) {
        try {
            await fs.access(resolveKey(key));
            return true;
        } catch {
            return false;
        }
    },

    // Idempotent: removing an already-absent file is a success, not an error.
    async remove(key) {
        try {
            await fs.unlink(resolveKey(key));
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
        }
    },
};

const drivers = { local: localDriver };

function getStorage() {
    const name = process.env.STORAGE_DRIVER ?? 'local';
    const driver = drivers[name];
    if (!driver) throw new Error(`Unknown STORAGE_DRIVER: ${name}`);
    return driver;
}

export { getStorage, resolveKey, buildKey };

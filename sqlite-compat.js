/**
 * Fallback SQLite driver.
 *
 * The project normally uses the native `sqlite3` package. On machines where the
 * native module cannot be compiled (no build toolchain / no network), this shim
 * provides the same small API surface (`run` / `get` / `all` / `serialize` /
 * `close`) on top of Node's built-in `node:sqlite` module (Node >= 22).
 *
 * Both drivers read and write the very same local `chat.db` file, so no data or
 * behaviour changes -- only the engine underneath.
 */
const { DatabaseSync } = require('node:sqlite');

class CompatDatabase {
    constructor(filename, callback) {
        try {
            this.db = new DatabaseSync(filename);
            this.db.exec('PRAGMA journal_mode = WAL;');
            this.db.exec('PRAGMA foreign_keys = ON;');
            if (callback) process.nextTick(() => callback.call(this, null));
        } catch (err) {
            if (callback) process.nextTick(() => callback.call(this, err));
            else throw err;
        }
    }

    // Normalises (sql, params?, callback?) argument shapes.
    static _args(params, callback) {
        if (typeof params === 'function') return [[], params];
        if (params === undefined || params === null) return [[], callback];
        return [Array.isArray(params) ? params : [params], callback];
    }

    // node:sqlite only accepts primitives; coerce booleans/undefined/dates.
    static _clean(params) {
        return params.map((p) => {
            if (typeof p === 'boolean') return p ? 1 : 0;
            if (p === undefined) return null;
            if (p instanceof Date) return p.toISOString();
            return p;
        });
    }

    run(sql, params, callback) {
        const [args, cb] = CompatDatabase._args(params, callback);
        let ctx = { lastID: 0, changes: 0 };
        let error = null;
        try {
            const result = this.db.prepare(sql).run(...CompatDatabase._clean(args));
            ctx = {
                lastID: Number(result.lastInsertRowid) || 0,
                changes: Number(result.changes) || 0
            };
        } catch (err) {
            error = err;
        }
        if (cb) process.nextTick(() => cb.call(ctx, error));
        return this;
    }

    get(sql, params, callback) {
        const [args, cb] = CompatDatabase._args(params, callback);
        let row;
        let error = null;
        try {
            row = this.db.prepare(sql).get(...CompatDatabase._clean(args));
        } catch (err) {
            error = err;
        }
        if (cb) process.nextTick(() => cb(error, row));
        return this;
    }

    all(sql, params, callback) {
        const [args, cb] = CompatDatabase._args(params, callback);
        let rows = [];
        let error = null;
        try {
            rows = this.db.prepare(sql).all(...CompatDatabase._clean(args));
        } catch (err) {
            error = err;
        }
        if (cb) process.nextTick(() => cb(error, rows));
        return this;
    }

    exec(sql, callback) {
        let error = null;
        try {
            this.db.exec(sql);
        } catch (err) {
            error = err;
        }
        if (callback) process.nextTick(() => callback(error));
        return this;
    }

    // Statements already run synchronously, so ordering is inherently serial.
    serialize(fn) {
        if (fn) fn();
        return this;
    }

    parallelize(fn) {
        if (fn) fn();
        return this;
    }

    close(callback) {
        let error = null;
        try {
            this.db.close();
        } catch (err) {
            error = err;
        }
        if (callback) process.nextTick(() => callback(error));
        return this;
    }
}

module.exports = { Database: CompatDatabase, verbose: () => module.exports };

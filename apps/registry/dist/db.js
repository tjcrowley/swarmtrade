"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const pool = new pg_1.Pool({
    user: 'a2a_admin',
    host: 'localhost',
    database: 'a2a_hub',
    password: 'secure_a2a_password',
    port: 5433,
});
exports.default = pool;

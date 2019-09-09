/*!
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT License.
 */

const { createHash } = require('crypto');
const { readFileSync, writeFileSync } = require('fs');
const { minify } = require('luamin');

// Read built source
const file = readFileSync('index.js', 'utf8');

// Read minified Lua script
const code =
    process.argv[2] === 'minify'
        ? minify(readFileSync('bucket.lua', 'utf8'))
        : readFileSync('bucket.lua', 'utf8');

// Generate SHA1 hash of Lua script for evalsha
const hash = createHash('sha1')
    .update(code, 'utf8')
    .digest('hex');

// Replace placeholder strings in source
const body = file
    .replace(`'{{LUA_CODE}}'`, JSON.stringify(code))
    .replace(`'{{LUA_HASH}}'`, JSON.stringify(hash));

// Output updated source
writeFileSync('index.js', body);

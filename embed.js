/*!
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT License.
 */

import { readFileSync, writeFileSync } from 'fs';

const script =
    process.argv[2] === 'minify'
        ? 'script/bucket.min.lua'
        : 'script/bucket.lua';

// Read built sources
const file = readFileSync('index.js', 'utf8');
const code = readFileSync(script, 'utf8');
const hash = readFileSync(script + '.sha1', 'utf8');

// Replace placeholder strings in source
const body = file
    .replace(`'{{LUA_CODE}}'`, JSON.stringify(code))
    .replace(`'{{LUA_HASH}}'`, JSON.stringify(hash));

// Output updated source
writeFileSync('index.js', body);

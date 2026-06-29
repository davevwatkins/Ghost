// One-off: Phase 2b sweep — strip `unique: true` from listed columns on
// per-site tables and add a composite `@@UNIQUE_CONSTRAINTS@@: [['site_id', col]]`
// entry per table. Run once: `node scripts/phase2b-sweep.js`.
const fs = require('fs');
const path = 'ghost/core/core/server/data/schema/schema.js';
let src = fs.readFileSync(path, 'utf8');

const targets = {
    newsletters: ['name', 'slug'],
    users: ['slug', 'email'],
    roles: ['name'],
    permissions: ['name'],
    tags: ['slug'],
    invites: ['email'],
    integrations: ['slug'],
    products: ['slug'],
    offers: ['name', 'code'],
    benefits: ['slug'],
    labels: ['name', 'slug'],
    snippets: ['name'],
    collections: ['slug'],
    email_design_settings: ['slug'],
    automations: ['name', 'slug'],
    jobs: ['name'],
    suppressions: ['email']
};

let removed = 0;
let missed = [];
for (const [table, cols] of Object.entries(targets)) {
    for (const col of cols) {
        const re = new RegExp('^(\\s{8}' + col + ':\\s*\\{[^}]*?), unique: true', 'm');
        const before = src;
        src = src.replace(re, '$1');
        if (src !== before) removed++;
        else missed.push(table + '.' + col);
    }
}

console.log('Removed ' + removed + ' inline unique flags');
if (missed.length) console.warn('MISSED: ' + missed.join(', '));

// Now add @@UNIQUE_CONSTRAINTS@@ to each target table. Find the closing
// `    },` of each table and inject the constraint block before it.
let added = 0;
for (const [table, cols] of Object.entries(targets)) {
    const pairs = cols.map(c => `['site_id', '${c}']`).join(', ');
    const constraintLine = `        '@@UNIQUE_CONSTRAINTS@@': [${pairs}]`;

    // Find the opening of this table.
    const openRe = new RegExp('^    ' + table + ': \\{$', 'm');
    const openMatch = src.match(openRe);
    if (!openMatch) {
        console.warn('No opener for table ' + table);
        continue;
    }
    const openIdx = openMatch.index;

    // Find the closing brace of this table (first `    },` after open).
    const closeRe = /^    \},?$/m;
    const after = src.slice(openIdx);
    const closeMatch = after.match(closeRe);
    if (!closeMatch) {
        console.warn('No closer for table ' + table);
        continue;
    }
    const closeIdx = openIdx + closeMatch.index;

    // Check whether the table already has @@UNIQUE_CONSTRAINTS@@.
    const slice = src.slice(openIdx, closeIdx);
    if (slice.includes('@@UNIQUE_CONSTRAINTS@@')) {
        console.warn('Table ' + table + ' already has @@UNIQUE_CONSTRAINTS@@ — skipping (review manually)');
        continue;
    }

    // Find the last column line before the closing brace. We need to add
    // a comma after it and insert the constraint block. The previous
    // non-empty line in `slice` is the last column.
    const lines = slice.split('\n');
    let lastColIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (/^\s{8}[a-zA-Z_'@]/.test(l)) {
            lastColIdx = i;
            break;
        }
    }
    if (lastColIdx === -1) {
        console.warn('No last column for table ' + table);
        continue;
    }

    // Ensure the last column line ends with a comma.
    let lastLine = lines[lastColIdx];
    if (!lastLine.trimEnd().endsWith(',')) {
        lines[lastColIdx] = lastLine.trimEnd() + ',';
    }
    // Insert the constraint line right after.
    lines.splice(lastColIdx + 1, 0, constraintLine);

    const newSlice = lines.join('\n');
    src = src.slice(0, openIdx) + newSlice + src.slice(closeIdx);
    added++;
}

console.log('Added @@UNIQUE_CONSTRAINTS@@ to ' + added + ' tables');
fs.writeFileSync(path, src);

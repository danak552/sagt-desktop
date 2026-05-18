const fs = require('fs');
const cp = require('child_process');
try {
    let out = cp.execSync('npx tsc --noEmit', { encoding: 'utf8' });
    fs.writeFileSync('tsc_output.txt', out, 'utf8');
} catch (e) {
    fs.writeFileSync('tsc_output.txt', e.stdout, 'utf8');
}

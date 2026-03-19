const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const aiDir = path.join(rootDir, 'ai');
const squadCoreDir = path.join(aiDir, 'squad', 'core');

const squadCoreModules = ['humanizer', 'rateLimiter', 'spintax', 'squadDB'];

function restoreSquadCore(dir) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const fullPath = path.join(dir, item);
        if (fs.statSync(fullPath).isDirectory()) {
            restoreSquadCore(fullPath);
        } else if (fullPath.endsWith('.js')) {
            let content = fs.readFileSync(fullPath, 'utf8');
            let changed = false;

            const squadCoreRegex = /require\((['"])((?:\.\.\/|\.\/)*)backend\/core\/(humanizer|rateLimiter|spintax|squadDB)(.*?)(['"])\)/g;

            content = content.replace(squadCoreRegex, (match, q1, oldPrefix, moduleName, rest, q2) => {
                // Calculate correct relative path from current file to ai/squad/core/
                let relPath = path.relative(path.dirname(fullPath), squadCoreDir);
                if (!relPath.startsWith('.')) relPath = './' + relPath;
                relPath = relPath.replace(/\\/g, '/'); // normalize for requires

                changed = true;
                return `require(${q1}${relPath}/${moduleName}${rest}${q2})`;
            });

            if (changed) {
                fs.writeFileSync(fullPath, content);
                console.log(`[Restored] ${path.relative(rootDir, fullPath)} -> mapped ${squadCoreRegex} inwards to squad/core`);
            }
        }
    }
}

if (fs.existsSync(aiDir)) {
    restoreSquadCore(aiDir);
    console.log('✅ Squad core modules successfully restored to internal linkage!');
} else {
    console.log('❌ ai/ directory not found');
}

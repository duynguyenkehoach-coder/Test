const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src');
const aiSquadDir = path.join(srcDir, 'ai', 'squad');
const squadDir = path.join(srcDir, 'squad');

if (!fs.existsSync(aiSquadDir) || !fs.existsSync(squadDir)) {
    console.log('One of the directories is missing. Nothing to consolidate.');
    process.exit(0);
}

function mergeDirs(source, target) {
    if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true });
    }
    const items = fs.readdirSync(source);
    for (const item of items) {
        const sPath = path.join(source, item);
        const tPath = path.join(target, item);
        const stat = fs.statSync(sPath);

        if (stat.isDirectory()) {
            mergeDirs(sPath, tPath);
        } else {
            if (fs.existsSync(tPath)) {
                const tStat = fs.statSync(tPath);
                if (stat.mtimeMs > tStat.mtimeMs) {
                    console.log(`[Migrate] ${item}: ai/squad (Newer) -> squad`);
                    fs.copyFileSync(sPath, tPath);
                } else {
                    console.log(`[Keep] ${item}: squad (Newer/Equal) kept`);
                }
            } else {
                console.log(`[Move] ${item}: ai/squad -> squad (Missing)`);
                fs.copyFileSync(sPath, tPath);
            }
        }
    }
}

mergeDirs(aiSquadDir, squadDir);

// Rewrite all require paths globally
function processDir(dir) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            if (item !== 'node_modules' && item !== '.git') {
                processDir(fullPath);
            }
        } else if (fullPath.endsWith('.js')) {
            let content = fs.readFileSync(fullPath, 'utf8');
            let changed = false;

            const newContent = content.replace(/require\((['"])(.*?)(ai\/squad)\/(.*?)(['"])\)/g, (match, q1, prefix, aisquad, target, q2) => {
                changed = true;
                return `require(${q1}${prefix}squad/${target}${q2})`;
            });

            if (changed) {
                fs.writeFileSync(fullPath, newContent);
                console.log(`[Rewrite] Updated paths in ${path.relative(srcDir, fullPath)}`);
            }
        }
    }
}

processDir(srcDir);

// Delete ai/squad directory safely
fs.rmSync(aiSquadDir, { recursive: true, force: true });
console.log('[Cleanup] Deleted duplicate folder: src/ai/squad');

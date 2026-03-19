const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src');
const agentDir = path.join(srcDir, 'agent');
const squadDir = path.join(srcDir, 'squad');
const aiDir = path.join(srcDir, 'ai');
const aiAgentsDir = path.join(aiDir, 'agents');
const aiSquadDir = path.join(aiDir, 'squad');

// 1. Rename directories
if (fs.existsSync(agentDir)) {
    console.log('[Move] src/agent -> src/ai/agents');
    fs.renameSync(agentDir, aiAgentsDir);
}

if (fs.existsSync(squadDir)) {
    console.log('[Move] src/squad -> src/ai/squad');
    fs.renameSync(squadDir, aiSquadDir);
}

// 2. Rewrite paths
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

            // Replace requires pointing to agent/
            // Match: require('.../agent/...'), require('./agent/...'), require('../agent/...')
            // We ensure it strictly matches the folder name 'agent/'
            const agentRegex = /require\((['"])((?:\.\.\/|\.\/)*)agent\/(.*?)(['"])\)/g;
            const newContentAgent = content.replace(agentRegex, (match, q1, prefix, target, q2) => {
                changed = true;
                return `require(${q1}${prefix}ai/agents/${target}${q2})`;
            });
            content = newContentAgent;

            // Replace requires pointing to squad/
            const squadRegex = /require\((['"])((?:\.\.\/|\.\/)*)squad\/(.*?)(['"])\)/g;
            const newContentSquad = content.replace(squadRegex, (match, q1, prefix, target, q2) => {
                changed = true;
                return `require(${q1}${prefix}ai/squad/${target}${q2})`;
            });
            content = newContentSquad;

            if (changed) {
                fs.writeFileSync(fullPath, content);
                console.log(`[Rewrite] Updated paths in ${path.relative(srcDir, fullPath)}`);
            }
        }
    }
}

// Update imports recursively
processDir(srcDir);

// Also check index.js and server.js in root
const rootFiles = ['server.js', 'index.js'].map(f => path.join(srcDir, f));
for (const rf of rootFiles) {
    if (fs.existsSync(rf)) {
        let content = fs.readFileSync(rf, 'utf8');
        let changed = false;

        const agentRegex = /require\((['"])((?:\.\.\/|\.\/)*)agent\/(.*?)(['"])\)/g;
        const newContentAgent = content.replace(agentRegex, (match, q1, prefix, target, q2) => {
            changed = true;
            return `require(${q1}${prefix}ai/agents/${target}${q2})`;
        });
        content = newContentAgent;

        const squadRegex = /require\((['"])((?:\.\.\/|\.\/)*)squad\/(.*?)(['"])\)/g;
        const newContentSquad = content.replace(squadRegex, (match, q1, prefix, target, q2) => {
            changed = true;
            return `require(${q1}${prefix}ai/squad/${target}${q2})`;
        });
        content = newContentSquad;

        if (changed) {
            fs.writeFileSync(rf, content);
            console.log(`[Rewrite] Updated paths in ${path.basename(rf)}`);
        }
    }
}

// Check package.json for npm scripts like `node src/squad/squadRunner.js`
const pkgPath = path.join(__dirname, '..', 'package.json');
if (fs.existsSync(pkgPath)) {
    let pkg = fs.readFileSync(pkgPath, 'utf8');
    if (pkg.includes('src/squad/')) {
        pkg = pkg.replace(/src\/squad\//g, 'src/ai/squad/');
        fs.writeFileSync(pkgPath, pkg);
        console.log('[Rewrite] Updated scripts in package.json');
    }
}

console.log('[Done] Structure successfully migrated to src/ai/');

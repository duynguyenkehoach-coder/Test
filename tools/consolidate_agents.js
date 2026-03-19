const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src');
const aiAgentsDir = path.join(srcDir, 'ai', 'agents');
const agentDir = path.join(srcDir, 'agent');

if (!fs.existsSync(aiAgentsDir) || !fs.existsSync(agentDir)) {
    console.log('One of the directories is missing. Nothing to consolidate.');
    process.exit(0);
}

// 1. Resolve Split-Brain Files (keep newest)
const aiFiles = fs.readdirSync(aiAgentsDir).filter(f => f.endsWith('.js'));
for (const f of aiFiles) {
    const aiPath = path.join(aiAgentsDir, f);
    const agPath = path.join(agentDir, f);

    // Skip accountManager because we already fixed it manually
    if (f === 'accountManager.js') continue;

    if (fs.existsSync(agPath)) {
        const aiStat = fs.statSync(aiPath);
        const agStat = fs.statSync(agPath);
        if (aiStat.mtimeMs > agStat.mtimeMs) {
            console.log(`[Migrate] ${f}: ai/agents (Newer) -> agent`);
            fs.copyFileSync(aiPath, agPath);
        } else {
            console.log(`[Keep] ${f}: agent (Newer/Equal) kept`);
        }
    } else {
        console.log(`[Move] ${f}: ai/agents -> agent (Missing)`);
        fs.copyFileSync(aiPath, agPath);
    }
}

// Also move the "knowledge" folder if it exists
const aiKnowledgeDir = path.join(aiAgentsDir, 'knowledge');
const agKnowledgeDir = path.join(agentDir, 'knowledge');
if (fs.existsSync(aiKnowledgeDir)) {
    if (!fs.existsSync(agKnowledgeDir)) fs.mkdirSync(agKnowledgeDir, { recursive: true });
    const kFiles = fs.readdirSync(aiKnowledgeDir);
    for (const kf of kFiles) {
        fs.copyFileSync(path.join(aiKnowledgeDir, kf), path.join(agKnowledgeDir, kf));
    }
}

// 2. Rewrite all require paths globally
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

            // Simple regex to catch require statements containing ai/agents
            // Examples: require('../ai/agents/...') -> require('../agent/...')
            // require('../../ai/agents/...') -> require('../../agent/...')
            const newContent = content.replace(/require\((['"])(.*?)(ai\/agents)\/(.*?)(['"])\)/g, (match, q1, prefix, aiagents, target, q2) => {
                changed = true;
                // Since ai/ is one level deeper than agent, if prefix is dot-dot paths, we need to adjust depth.
                // e.g. from src/routes (depth 1): 
                //    require('../ai/agents/X') -> require('../agent/X')
                // e.g. from src/infra/scraper (depth 2):
                //    require('../../ai/agents/X') -> require('../../agent/X')

                // Usually replacing `/ai/agents/` with `/agent/` works fine if they share the `src/` parent.
                return `require(${q1}${prefix}agent/${target}${q2})`;
            });

            if (changed) {
                fs.writeFileSync(fullPath, newContent);
                console.log(`[Rewrite] Updated paths in ${path.relative(srcDir, fullPath)}`);
            }
        }
    }
}

processDir(srcDir);

// 3. Delete ai/agents directory safely
fs.rmSync(aiAgentsDir, { recursive: true, force: true });
console.log('[Cleanup] Deleted duplicate folder: src/ai/agents');

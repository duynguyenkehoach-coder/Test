// Script to reset FB account status in DB
require('dotenv').config({ path: '../.env' });
const db = require('../src/data_store/database');

const email = 'manyhope0502@gmail.com';

try {
    const before = db.db.prepare('SELECT email, status, trust_score, checkpoint_count FROM fb_accounts WHERE email = ?').get(email);
    console.log('Before:', JSON.stringify(before));

    db.db.prepare(`
        UPDATE fb_accounts 
        SET status = 'active', 
            trust_score = 80, 
            checkpoint_count = 0,
            last_used = NULL
        WHERE email = ?
    `).run(email);

    const after = db.db.prepare('SELECT email, status, trust_score, checkpoint_count FROM fb_accounts WHERE email = ?').get(email);
    console.log('After :', JSON.stringify(after));
    console.log('✅ Account reset successfully!');
} catch (err) {
    console.error('❌ Error:', err.message);
}
process.exit(0);

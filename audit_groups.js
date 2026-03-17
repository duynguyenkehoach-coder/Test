const Database = require('better-sqlite3');
const db = new Database('data/groups.db');

// Count before
const before = db.prepare('SELECT COUNT(*) as t FROM fb_groups').get().t;
const active = db.prepare("SELECT COUNT(*) as t FROM fb_groups WHERE status='active'").get().t;
const toDelete = db.prepare("SELECT COUNT(*) as t FROM fb_groups WHERE status != 'active' OR status IS NULL").get().t;

console.log(`BEFORE: ${before} total, ${active} active, ${toDelete} to delete`);

// Delete inactive + dead + null
const result = db.prepare("DELETE FROM fb_groups WHERE status != 'active' OR status IS NULL").run();
console.log(`DELETED: ${result.changes} groups`);

// Count after
const after = db.prepare('SELECT COUNT(*) as t FROM fb_groups').get().t;
console.log(`AFTER: ${after} groups remaining (all active)`);

db.close();
console.log('✅ Done! Database cleaned.');

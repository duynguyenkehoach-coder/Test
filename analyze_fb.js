// Analyze the raw mbasic HTML to find actual DOM patterns
const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('/tmp/mbasic_raw.html', 'utf8');
const $ = cheerio.load(html);

console.log('=== Raw mbasic HTML Analysis ===');
console.log('Size:', html.length, 'bytes');

// Count basic elements
console.log('\n--- Element counts ---');
const tags = ['p', 'h1', 'h2', 'h3', 'h4', 'div', 'span', 'a', 'article', 'section', 'form', 'table', 'img', 'strong', 'header', 'footer'];
for (const t of tags) {
    const c = $(t).length;
    if (c > 0) console.log(`  <${t}>: ${c}`);
}

// Check for various link patterns
console.log('\n--- Link patterns ---');
const linkPatterns = {
    'story.php': 'a[href*="story.php"]',
    'permalink': 'a[href*="permalink"]',
    '/posts/': 'a[href*="/posts/"]',
    'comment': 'a[href*="comment"]',
    'groups/': 'a[href*="groups/"]',
    'profile.php': 'a[href*="profile.php"]',
    '/photo': 'a[href*="/photo"]',
    'mbasic': 'a[href*="mbasic"]',
};
for (const [k, sel] of Object.entries(linkPatterns)) {
    const c = $(sel).length;
    if (c > 0) console.log(`  ${k}: ${c} links`);
}

// Show first 20 unique hrefs
console.log('\n--- First 20 unique href patterns ---');
const hrefs = new Set();
$('a[href]').each((_, a) => {
    const h = ($(a).attr('href') || '').substring(0, 80);
    if (h && hrefs.size < 20) hrefs.add(h);
});
for (const h of hrefs) console.log(`  ${h}`);

// Look for text content containers
console.log('\n--- Divs with >50 chars text ---');
let longDivCount = 0;
$('div').each((_, el) => {
    const t = $(el).children().length === 0 ? $(el).text().trim() : '';
    if (t.length > 50 && longDivCount < 10) {
        console.log(`  [${longDivCount}] (${t.length}ch): ${t.substring(0, 120)}`);
        longDivCount++;
    }
});
console.log(`  Total leaf divs with >50 chars: ${$('div').filter((_, el) => $(el).children().length === 0 && $(el).text().trim().length > 50).length}`);

// Check for "checkpoint" context
console.log('\n--- Checkpoint context ---');
const checkpointIndex = html.indexOf('checkpoint');
if (checkpointIndex >= 0) {
    const ctx = html.substring(Math.max(0, checkpointIndex - 100), checkpointIndex + 100);
    console.log('  Context:', ctx.replace(/\n/g, ' ').substring(0, 200));
}

// Show a sample of the raw HTML (first 1000 chars after <body>)
const bodyStart = html.indexOf('<body');
if (bodyStart >= 0) {
    const bodyContent = html.substring(bodyStart, bodyStart + 1500);
    console.log('\n--- First 1500 chars of body ---');
    console.log(bodyContent.substring(0, 1500));
}

// Check for specific keywords that indicate group content vs login
console.log('\n--- Content indicators ---');
const indicators = ['login_form', 'loginform', 'mbasic_inline_feed', 'Cộng Đồng', 'group_feed', 'composer', 'Write something', 'Viết gì đó'];
for (const i of indicators) {
    console.log(`  "${i}": ${html.includes(i)}`);
}

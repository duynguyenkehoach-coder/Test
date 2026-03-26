const axios = require('axios');
const fs = require('fs');
const urls = [
    'https://www.facebook.com/share/g/1DEkXgMPwr/',
    'https://www.facebook.com/share/g/1Cr4Xb87b3/',
    'https://www.facebook.com/share/g/1DawXDDcyD/',
    'https://www.facebook.com/share/g/1D8Yp71Ciq/',
    'https://www.facebook.com/share/g/182xxqAWhE/',
    'https://www.facebook.com/share/g/14fpKk3Se3U/',
    'https://www.facebook.com/share/g/1Htbu4gvKG/',
    'https://www.facebook.com/share/g/1BvxZZcEj2/',
    'https://www.facebook.com/share/g/18JJMcCo2n/',
    'https://www.facebook.com/share/g/1CgmUtE4Mk/',
    'https://www.facebook.com/share/g/1HM5f6gTYM/',
    'https://www.facebook.com/share/g/1DzSk5LuEh/',
    'https://www.facebook.com/share/g/1DzNywuRsS/'
];

async function run() {
    for (let url of urls) {
        try {
            const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/100.0.4896.75' } });
            const titleMatch = res.data.match(/<title[^>]*>([^<]+)<\/title>/i);
            let title = titleMatch ? titleMatch[1].replace(' | Facebook', '').trim() : 'Unknown';
            if (title.length > 100) title = 'Unknown';
            console.log(`    { name: '${title}', url: '${url}' },`);
        } catch (e) {
            console.log(`    { name: 'Unknown', url: '${url}' },`);
        }
    }
}
run();

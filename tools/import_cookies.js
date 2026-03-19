const fs = require('fs');
const path = require('path');

const cookies = [
    {
        email: "thacher8agqa@hotmail.com",
        cookieStr: "c_user=61586706401410;xs=38:5mxADvXTO6c3RQ:2:1773723575:-1:-1;fr=0f0DXgJnYOeeWnK04.AWfq2FFl4USOGNsgXocaWjABiw030ibaaO1b_y_figlTBhoQIyU.BpuN-_..AAA.0.0.BpuN-_.AWdz0TsO-Z9v4Q-Tr4_hN1EK0MU;datr=v9-4aRQVX3aliQMdGeYS26dk;"
    },
    {
        email: "guntar_geoffry460.jared@hotmail.com",
        cookieStr: "c_user=61586637071094;xs=32:jVp3Z4fXd9O3TA:2:1773723867:-1:-1;fr=0crDTi8XklfzAQEic.AWezd1yTEvEtZPwfcnVj9ICthflCVu8qHUBSuoVnap58wC1vfDs.BpuODj..AAA.0.0.BpuODj.AWflhBvmQgbnccPOzUG3m-OxqJk;datr=4-C4aQl01tFiBid7iHXKhJje;"
    }
];

const sessionsDir = path.join(__dirname, '..', 'data', 'fb_sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

cookies.forEach(({ email, cookieStr }) => {
    const pwCookies = cookieStr.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
        const [name, ...val] = pair.split('=');
        return {
            name: name,
            value: val.join('='),
            domain: ".facebook.com",
            path: "/",
            expires: Date.now() / 1000 + 31536000,
            httpOnly: name === 'xs' || name === 'c_user' || name === 'datr' || name === 'fr',
            secure: true,
            sameSite: "None"
        };
    });

    const sessionData = {
        cookies: pwCookies,
        origins: [{
            origin: "https://www.facebook.com",
            localStorage: []
        }]
    };

    const fileName = email.replace(/[^a-z0-9]/gi, '_') + '.json';
    fs.writeFileSync(path.join(sessionsDir, fileName), JSON.stringify(sessionData, null, 2));
    console.log(`[+] Saved pristine session for ${email} at ${fileName}`);
});

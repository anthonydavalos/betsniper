const puppeteer = require('puppeteer');

(async () => {
    console.log("🚀 Storage Spy...");
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    
    try {
        await page.goto('https://www.pinnacle.com/', { waitUntil: 'networkidle2' });
        console.log("✅ Loaded.");
        
        // Dump LocalStorage
        const localStorageData = await page.evaluate(() => {
            let data = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                data[key] = localStorage.getItem(key);
            }
            return data;
        });
        
        console.log("\n📦 LocalStorage:");
        Object.keys(localStorageData).forEach(k => {
             const val = localStorageData[k];
             const displayVal = val.length > 100 ? val.substring(0, 100) + '...' : val;
             console.log(`${k}: ${displayVal}`);
        });

        // Dump SessionStorage
        const sessionStorageData = await page.evaluate(() => {
            let data = {};
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                data[key] = sessionStorage.getItem(key);
            }
            return data;
        });
        
        console.log("\n📦 SessionStorage:");
        Object.keys(sessionStorageData).forEach(k => {
             const val = sessionStorageData[k];
             const displayVal = val.length > 100 ? val.substring(0, 100) + '...' : val;
             console.log(`${k}: ${displayVal}`);
        });
        
    } catch (e) {
        console.log("Err:", e.message);
    }
    
    await browser.close();
})();

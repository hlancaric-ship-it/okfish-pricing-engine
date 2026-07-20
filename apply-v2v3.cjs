const fs = require('fs');
const path = require('path');

const files = [
    'src/cli/customers.ts',
    'src/cli/customers-xlsx.ts'
];

for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    
    // Add crypto import if missing
    if (!content.includes("import * as crypto from 'crypto';")) {
        content = content.replace("import * as fs from 'fs';", "import * as fs from 'fs';\nimport * as crypto from 'crypto';");
    }

    // Replace the JS output logic
    const oldCodeRegex = /\n[ \t]*const sortedKeys = Object\.keys\(vipDiscountsMap\)\.sort\(\);\n([\s\S]*?)fs\.writeFileSync\(.*?'vip-discounts\.js'\), jsContent\);/g;
    
    const newCode = `
            const sortedKeys = Object.keys(vipDiscountsMap).sort();
            const sortedMap = {};
            for (const key of sortedKeys) {
                sortedMap[key] = vipDiscountsMap[key];
            }

            const now = new Date();
            const dateStr = now.toISOString().replace('T', ' ').substring(0, 16);
            
            // --- V2: Single JSON file ---
            const v2Data = {
                generatedAt: dateStr,
                customersCount: totalCustomers,
                customers: sortedMap
            };
            const dir = file.includes('xlsx') ? exportsDir : path.dirname(outputPath);
            fs.writeFileSync(path.join(dir, 'vip-discounts.json'), JSON.stringify(v2Data, null, 2));

            // --- V3: Directory with individual hashes ---
            const vipDir = path.join(dir, 'vip');
            if (fs.existsSync(vipDir)) {
                fs.rmSync(vipDir, { recursive: true, force: true });
            }
            fs.mkdirSync(vipDir, { recursive: true });

            for (const [email, discount] of Object.entries(vipDiscountsMap)) {
                const hash = crypto.createHash('sha256').update(email).digest('hex');
                fs.writeFileSync(path.join(vipDir, \`\${hash}.json\`), JSON.stringify({ discount }));
            }
`;

    content = content.replace(oldCodeRegex, newCode);
    
    // Fix console logs
    content = content.replace(
        "console.log(`\\n✅ Úspěšně vygenerováno: exports/customers_import.csv`);\n            console.log(`✅ Úspěšně vygenerováno: exports/vip-discounts.js`);",
        "console.log(`\\n✅ Úspěšně vygenerováno: exports/customers_import.csv`);\n            console.log(`✅ Úspěšně vygenerováno: exports/vip-discounts.json (V2)`);\n            console.log(`✅ Úspěšně vygenerováno: exports/vip/ složka (V3 s hashy)`);"
    );
    content = content.replace(
        "console.log(`\\n✅ Úspěšně vygenerováno: exports/customers_import.xlsx`);\n    console.log(`✅ Úspěšně vygenerováno: exports/vip-discounts.js`);",
        "console.log(`\\n✅ Úspěšně vygenerováno: exports/customers_import.xlsx`);\n    console.log(`✅ Úspěšně vygenerováno: exports/vip-discounts.json (V2)`);\n    console.log(`✅ Úspěšně vygenerováno: exports/vip/ složka (V3 s hashy)`);"
    );

    fs.writeFileSync(file, content);
}
console.log("Done");

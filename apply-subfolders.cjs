const fs = require('fs');
const path = require('path');

const files = [
    'src/cli/customers.ts',
    'src/cli/customers-xlsx.ts'
];

for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    
    const oldCode = `            for (const [email, discount] of Object.entries(vipDiscountsMap)) {
                const hash = crypto.createHash('sha256').update(email).digest('hex');
                fs.writeFileSync(path.join(vipDir, \`\${hash}.json\`), JSON.stringify({ discount }));
            }`;

    const newCode = `            const createdDirs = new Set();
            for (const [email, discount] of Object.entries(vipDiscountsMap)) {
                const hash = crypto.createHash('sha256').update(email).digest('hex');
                const prefix = hash.substring(0, 2);
                const subDir = path.join(vipDir, prefix);
                if (!createdDirs.has(prefix)) {
                    if (!fs.existsSync(subDir)) fs.mkdirSync(subDir);
                    createdDirs.add(prefix);
                }
                fs.writeFileSync(path.join(subDir, \`\${hash}.json\`), JSON.stringify({ discount }));
            }`;

    content = content.replace(oldCode, newCode);
    fs.writeFileSync(file, content);
}
console.log("Done");

import { stringify } from 'csv-stringify';
import * as fs from 'fs';
import * as path from 'path';

async function generateCustomerImport() {
    const exportsDir = path.join(process.cwd(), 'exports');
    if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir);
    }
    
    // Ukázkový mock zákazníků (v reálu by se načítal ze vstupu např. customer_export.csv)
    const mockCustomers = [
        { email: 'a@b.cz', priceList: 'ZR20' },
        { email: 'c@d.cz', priceList: 'ZR14' }
    ];

    return new Promise((resolve, reject) => {
        const writableStream = fs.createWriteStream(path.join(exportsDir, 'customers_import.csv'));
        const stringifier = stringify({
            header: true,
            delimiter: ';',
            columns: [
                { key: 'Email', header: 'Email' },
                { key: 'PriceList', header: 'PriceList' }
            ]
        });
        
        stringifier.on('error', (err) => reject(err));
        writableStream.on('error', (err) => reject(err));
        writableStream.on('finish', () => resolve(true));

        stringifier.pipe(writableStream);

        for (const customer of mockCustomers) {
            stringifier.write({
                Email: customer.email,
                PriceList: customer.priceList
            });
        }
        stringifier.end();
    });
}

generateCustomerImport()
    .then(() => console.log("Generated exports/customers_import.csv"))
    .catch(console.error);

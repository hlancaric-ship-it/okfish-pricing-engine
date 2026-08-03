// Applies per-brand pricing rules directly inside a Shoptet product export .xlsx.
// Two rule modes:
//   - 'baseline_sale': everyone gets at least this % off (via actionPrice), but a
//     customer's own loyalty tier can still beat it if higher — so maxDiscount is
//     explicitly CLEARED (blank), never capped at the baseline %.
//   - 'hard_cap': maxDiscount is set to this %, a real ceiling no tier can exceed.
// Same raw-OOXML cell-rewriting technique as setMaxDiscountByBrand.js / xlsxProductProcessor.js.
'use strict';

const AdmZip = require('adm-zip');
const { StringDecoder } = require('string_decoder');

const CHUNK_SIZE = 4 * 1024 * 1024;

function s(v) { return v === undefined || v === null ? '' : v; }

function buildHeaderColumnMap(headerRowXml) {
    const map = new Map();
    const cellRe = /<c r="([A-Z]+)1"[^>]*><is><t[^>]*>([^<]*)<\/t><\/is><\/c>/g;
    let m;
    while ((m = cellRe.exec(headerRowXml))) map.set(m[2], m[1]);
    if (map.size === 0) throw new Error('No header cells could be parsed — unexpected worksheet structure');
    return map;
}

function extractCellValue(rowXml, col) {
    const re = new RegExp(`<c r="${col}\\d+"[^>]*>(?:<v>([^<]*)</v>|<is><t[^>]*>([^<]*)</t></is>)?(?:</c>)?`);
    const m = rowXml.match(re);
    if (!m) return undefined;
    return m[1] !== undefined ? m[1] : m[2];
}

function getCellStyle(rowXml, col) {
    const re = new RegExp(`<c r="${col}\\d+" s="(\\d+)"`);
    const m = rowXml.match(re);
    return m ? m[1] : null;
}

function replaceNumericCellValue(rowXml, col, newValue) {
    const numericRe = new RegExp(`(<c r="${col}\\d+"[^>]*>)<v>[^<]*</v>`);
    if (numericRe.test(rowXml)) {
        return rowXml.replace(numericRe, (full, openTag) => `${openTag}<v>${newValue}</v>`);
    }
    const inlineStrRe = new RegExp(`<c r="${col}\\d+"([^>]*)t="inlineStr"([^>]*)><is><t[^>]*>[^<]*</t></is></c>`);
    if (inlineStrRe.test(rowXml)) {
        return rowXml.replace(inlineStrRe, (full) => {
            const refMatch = full.match(/r="([A-Z]+\d+)"/);
            const styleMatch = full.match(/s="(\d+)"/);
            const ref = refMatch[1];
            const style = styleMatch ? ` s="${styleMatch[1]}"` : '';
            return `<c r="${ref}"${style}><v>${newValue}</v></c>`;
        });
    }
    return null; // no cell present for this column on this row
}

/** Clears a cell back to the same blank inlineStr shape Shoptet exports use for empty fields. */
function clearCellToBlank(rowXml, col) {
    const style = getCellStyle(rowXml, col) || '5'; // '5' observed as the standard blank-text style in real exports
    const cellRe = new RegExp(`<c r="(${col}\\d+)"[^>]*(?:>(?:<v>[^<]*</v>|<is><t[^>]*>[^<]*</t></is>)?</c>|/>)`);
    const m = rowXml.match(cellRe);
    if (!m) return null;
    const ref = m[1];
    return rowXml.replace(cellRe, `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve"></t></is></c>`);
}

/**
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {{brand: string, mode: 'baseline_sale'|'hard_cap', percent: number}[]} rules
 * @param {(msg: string) => void} log
 */
function setBrandRules(inputPath, outputPath, rules, log) {
    const normalizedRules = rules.map(r => ({ ...r, brand: r.brand.trim().toLowerCase() }));

    log(`Otevírám ${inputPath}...`);
    const zip = new AdmZip(inputPath);
    const sheetEntry = zip.getEntry('xl/worksheets/sheet1.xml');
    if (!sheetEntry) throw new Error('xl/worksheets/sheet1.xml not found — is this a valid Shoptet product export .xlsx?');

    const sourceBuffer = sheetEntry.getData();
    log(`Načteno, velikost listu: ${(sourceBuffer.length / 1024 / 1024).toFixed(1)} MB`);

    const decoder = new StringDecoder('utf8');
    const outputChunks = [];
    let textBuffer = '';

    let inputCols = null;
    let rowCount = 0;
    const brandCounts = {};
    const allManufacturers = new Set();

    function pushText(str) { if (str.length > 0) outputChunks.push(Buffer.from(str, 'utf8')); }

    function processCompleteRows(isFinal) {
        while (true) {
            const rowStart = textBuffer.indexOf('<row ');
            if (rowStart === -1) break;
            const rowEnd = textBuffer.indexOf('</row>', rowStart);
            if (rowEnd === -1) {
                if (!isFinal) break;
                else throw new Error('Unterminated <row> — corrupt worksheet XML');
            }
            const rowEndFull = rowEnd + '</row>'.length;

            pushText(textBuffer.slice(0, rowStart));
            let rowXml = textBuffer.slice(rowStart, rowEndFull);
            textBuffer = textBuffer.slice(rowEndFull);

            const isHeaderRow = /<row r="1"/.test(rowXml);
            if (isHeaderRow) {
                const headerMap = buildHeaderColumnMap(rowXml);
                inputCols = {
                    code: headerMap.get('code'),
                    manufacturer: headerMap.get('manufacturer'),
                    price: headerMap.get('price'),
                    actionPrice: headerMap.get('actionPrice'),
                    maxDiscount: headerMap.get('maxDiscount')
                };
                for (const [name, col] of Object.entries(inputCols)) {
                    if (!col) throw new Error(`Required column "${name}" not found in header`);
                }
                pushText(rowXml);
                continue;
            }

            if (!inputCols) throw new Error('Data row encountered before header row was parsed');
            rowCount++;

            const manufacturer = s(extractCellValue(rowXml, inputCols.manufacturer)).trim().toLowerCase();
            if (manufacturer) allManufacturers.add(manufacturer);
            const rule = normalizedRules.find(r => r.brand === manufacturer);

            if (rule) {
                brandCounts[rule.brand] = (brandCounts[rule.brand] || 0) + 1;

                if (rule.mode === 'baseline_sale') {
                    const priceStr = extractCellValue(rowXml, inputCols.price);
                    const price = parseFloat(priceStr);
                    if (!isNaN(price) && price > 0) {
                        const baselinePrice = Math.round(price * (1 - rule.percent / 100) * 100) / 100;
                        // Výprodej-ochrana: pokud už produkt má nastavenou vlastní akční cenu
                        // (výprodej) nižší než tahle plošná % sleva, tu výprodejovou cenu
                        // NEPŘEPISUJEME — zákazník nesmí dopadnout hůř, než jak to má teď.
                        const existingRaw = extractCellValue(rowXml, inputCols.actionPrice);
                        const existing = parseFloat(existingRaw);
                        const finalPrice = (!isNaN(existing) && existing > 0 && existing < baselinePrice)
                            ? existing
                            : baselinePrice;
                        const updated = replaceNumericCellValue(rowXml, inputCols.actionPrice, finalPrice.toFixed(2));
                        if (updated !== null) rowXml = updated;
                    }
                    const cleared = clearCellToBlank(rowXml, inputCols.maxDiscount);
                    if (cleared !== null) rowXml = cleared;
                } else if (rule.mode === 'hard_cap') {
                    const updated = replaceNumericCellValue(rowXml, inputCols.maxDiscount, String(rule.percent));
                    if (updated !== null) rowXml = updated;
                }
            }

            pushText(rowXml);
            if (rowCount % 2000 === 0) log(`...prohledáno ${rowCount} produktů`);
        }
    }

    for (let offset = 0; offset < sourceBuffer.length; offset += CHUNK_SIZE) {
        const chunk = sourceBuffer.subarray(offset, Math.min(offset + CHUNK_SIZE, sourceBuffer.length));
        textBuffer += decoder.write(chunk);
        processCompleteRows(false);
    }
    textBuffer += decoder.end();
    processCompleteRows(true);
    pushText(textBuffer);

    const outBuffer = Buffer.concat(outputChunks);
    zip.updateFile(sheetEntry.entryName, outBuffer);
    zip.writeZip(outputPath);

    log(`HOTOVO. Prohledáno: ${rowCount} produktů.`);
    for (const [brand, count] of Object.entries(brandCounts)) log(`  ${brand}: ${count} produktů`);
    const unmatched = normalizedRules.filter(r => !brandCounts[r.brand]);
    if (unmatched.length > 0) {
        for (const rule of unmatched) {
            const suggestions = [...allManufacturers].filter(m => m.includes(rule.brand) || rule.brand.includes(m));
            log(`⚠️  "${rule.brand}" nenašlo shodu${suggestions.length ? ' — možná: ' + suggestions.slice(0, 5).join(', ') : ''}`);
        }
    }

    return { rowCount, brandCounts };
}

module.exports = { setBrandRules };

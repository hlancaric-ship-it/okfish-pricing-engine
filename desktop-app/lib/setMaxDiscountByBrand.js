// Sets the `maxDiscount` column for every product whose `manufacturer` matches
// one of the given brand rules, directly inside a Shoptet product export .xlsx.
// Uses the same raw-OOXML cell-rewriting technique as xlsxProductProcessor.js
// (proven safe in production — a spreadsheet library's own writer was found to
// corrupt multi-byte UTF-8 text under certain conditions). Only the exact cells
// that actually change are touched; everything else in the file is left
// byte-for-byte as it was, so it's safe to re-import straight into Shoptet.
'use strict';

const AdmZip = require('adm-zip');
const { StringDecoder } = require('string_decoder');

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB

function s(v) { return v === undefined || v === null ? '' : v; }

function buildHeaderColumnMap(headerRowXml) {
    const map = new Map(); // name -> column letter
    const cellRe = /<c r="([A-Z]+)1"[^>]*><is><t[^>]*>([^<]*)<\/t><\/is><\/c>/g;
    let m;
    while ((m = cellRe.exec(headerRowXml))) {
        map.set(m[2], m[1]);
    }
    if (map.size === 0) throw new Error('No header cells could be parsed — unexpected worksheet structure');
    return map;
}

function extractCellValue(rowXml, col) {
    const re = new RegExp(`<c r="${col}\\d+"[^>]*>(?:<v>([^<]*)</v>|<is><t[^>]*>([^<]*)</t></is>)?(?:</c>)?`);
    const m = rowXml.match(re);
    if (!m) return undefined;
    return m[1] !== undefined ? m[1] : m[2];
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
    // Column exists in header but this particular row has no cell for it at all
    // (Excel omits fully-empty trailing cells) — can't safely fabricate a new
    // <c> element without knowing the exact position/style convention, so this
    // row is reported as skipped rather than silently guessed at.
    return null;
}

/**
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {{brand: string, percent: number}[]} brandRules
 * @param {(msg: string) => void} log
 */
function setMaxDiscountByBrand(inputPath, outputPath, brandRules, log) {
    const normalizedRules = brandRules.map(r => ({ brand: r.brand.trim().toLowerCase(), percent: r.percent }));

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
    let matchedCount = 0;
    let changedCount = 0;
    let skippedNoCell = 0;
    const brandCounts = {};
    const allManufacturers = new Set(); // every distinct manufacturer seen, for typo suggestions

    function pushText(str) {
        if (str.length > 0) outputChunks.push(Buffer.from(str, 'utf8'));
    }

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
                    maxDiscount: headerMap.get('maxDiscount')
                };
                if (!inputCols.code) throw new Error('Required column "code" not found in header');
                if (!inputCols.manufacturer) throw new Error('Required column "manufacturer" not found in header — nelze filtrovat podle značky');
                if (!inputCols.maxDiscount) throw new Error('Required column "maxDiscount" not found in header');
                pushText(rowXml);
                continue;
            }

            if (!inputCols) throw new Error('Data row encountered before header row was parsed');

            rowCount++;
            const manufacturer = s(extractCellValue(rowXml, inputCols.manufacturer)).trim().toLowerCase();
            if (manufacturer) allManufacturers.add(manufacturer);
            const rule = normalizedRules.find(r => r.brand === manufacturer);

            if (rule) {
                matchedCount++;
                const current = extractCellValue(rowXml, inputCols.maxDiscount);
                const newValue = String(rule.percent);
                if (current !== newValue) {
                    const updated = replaceNumericCellValue(rowXml, inputCols.maxDiscount, newValue);
                    if (updated === null) {
                        skippedNoCell++;
                    } else {
                        rowXml = updated;
                        changedCount++;
                    }
                }
                brandCounts[rule.brand] = (brandCounts[rule.brand] || 0) + 1;
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

    log(`HOTOVO. Prohledáno: ${rowCount}, nalezeno podle značky: ${matchedCount}, upraveno: ${changedCount}${skippedNoCell > 0 ? `, přeskočeno (chybějící buňka): ${skippedNoCell}` : ''}.`);
    for (const [brand, count] of Object.entries(brandCounts)) {
        log(`  ${brand}: ${count} produktů`);
    }
    const unmatchedRules = normalizedRules.filter(r => !brandCounts[r.brand]);
    if (unmatchedRules.length > 0) {
        log(`⚠️  Tyto značky nenašly ani jednu shodu — možný překlep:`);
        for (const rule of unmatchedRules) {
            // Suggest real manufacturer names that contain the typed brand (or vice
            // versa) — catches "Mikado" vs "MIKADO SK", trailing spaces, missing
            // diacritics, etc. without needing a full fuzzy-match library.
            const suggestions = [...allManufacturers].filter(
                m => m.includes(rule.brand) || rule.brand.includes(m)
            );
            if (suggestions.length > 0) {
                log(`   "${rule.brand}" — možná jsi myslel: ${suggestions.slice(0, 5).join(', ')}`);
            } else {
                log(`   "${rule.brand}" — v souboru se nenašla ani podobná značka, zkontroluj přesné psaní.`);
            }
        }
    }

    return { rowCount, matchedCount, changedCount, brandCounts };
}

module.exports = { setMaxDiscountByBrand };

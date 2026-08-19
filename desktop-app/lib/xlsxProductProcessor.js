// Recalculates loyalty-tier pricelist prices directly inside a Shoptet product export
// .xlsx — same technique proven safe in production on 2026-07-23 (raw OOXML cell
// rewriting, not a spreadsheet library's own writer, which was found to corrupt
// multi-byte UTF-8 text under certain conditions). Only the exact cells needed are
// touched; everything else in the file is left byte-for-byte as it was.
//
// Processes the worksheet XML in chunks via a Buffer + StringDecoder, never
// materializing the whole decompressed sheet as one JS string — large real-world
// exports can decompress to 700MB+ of XML (verbose per-cell format), well past
// Node's ~536M-character string limit (confirmed via ERR_STRING_TOO_LONG on a real
// 16,633-product export). Output is assembled as Buffers and Buffer.concat()'d,
// which has no such character-count ceiling.
'use strict';

const AdmZip = require('adm-zip');
const { StringDecoder } = require('string_decoder');
const { calculateAllTierPrices } = require('./pricingEngine');
const { TIER_TO_PRICELIST_ID } = require('./policy');
const { loadAll: loadPolicyRules } = require('./policyManager');
const { resolveProductLimits } = require('./resolveProductLimits');

const INPUT_FIELD_NAMES = [
    'code', 'price', 'actionPrice', 'standardPrice', 'priceRatio', 'purchasePrice',
    'maxDiscount', 'percentVat', 'applyLoyaltyDiscount', 'manufacturer', 'categoryText'
];

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
    throw new Error(`Cell for column ${col} not found in row (neither numeric nor inlineStr)`);
}

function setInlineStrValue(rowXml, col, newValue) {
    const re = new RegExp(`(<c r="${col}\\d+"[^>]*t="inlineStr"[^>]*><is><t[^>]*>)[^<]*(</t></is></c>)`);
    if (!re.test(rowXml)) return rowXml; // column not present for this pricelist on this row — skip quietly
    return rowXml.replace(re, (full, pre, post) => `${pre}${newValue}${post}`);
}

/**
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {(msg: string) => void} log
 */
function processProductXlsx(inputPath, outputPath, log) {
    // BUG opraveno 2026-08-19: dřív se sem vůbec nepředávaly brand/category/product
    // limity ani celoroční brandová akční cena -- calculateAllTierPrices(row) se
    // volalo bez druhého parametru, takže tahle funkce (na rozdíl od živého Worker
    // syncu) počítala ceny BEZ ochrany stropem slevy. Appka tuhle konkrétní XLSX
    // funkci aktuálně nepoužívá (Jan potvrdil 2026-08-19), ale oprava se dělá
    // rovnou pro release, ať appka zůstane 1:1 se stejnými pravidly, co reálně běží.
    let limits;
    try {
        const policyData = loadPolicyRules();
        limits = {
            productLimits: resolveProductLimits(policyData),
            brandLimits: policyData.brandLimits,
            categoryLimits: policyData.categoryLimits,
            brandSaleDiscounts: policyData.brandSaleDiscounts,
        };
        log(`Pravidla načtena: ${Object.keys(limits.brandLimits).length} značkových stropů, ` +
            `${Object.keys(limits.categoryLimits).length} kategoriových stropů, ` +
            `${Object.keys(limits.productLimits).length} produktových stropů.`);
    } catch (e) {
        throw new Error(`Nepodařilo se načíst pravidla (policy-v1.json a související soubory): ${e.message}`);
    }

    log(`Otevírám ${inputPath}...`);
    const zip = new AdmZip(inputPath);

    const sheetEntry = zip.getEntry('xl/worksheets/sheet1.xml');
    if (!sheetEntry) throw new Error('xl/worksheets/sheet1.xml not found — is this a valid Shoptet product export .xlsx?');

    const sourceBuffer = sheetEntry.getData();
    log(`Načteno, velikost listu: ${(sourceBuffer.length / 1024 / 1024).toFixed(1)} MB`);

    const decoder = new StringDecoder('utf8');
    const outputChunks = []; // Buffer[]
    let textBuffer = ''; // small rolling text window, never the whole file

    let headerMap = null;
    let inputCols = null;
    let tierCols = null;
    let includingVatCols = null;

    let rowCount = 0;
    let changedCells = 0;
    const productsForSync = []; // { code, row } — same shape sync-products.ts uploads

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
                headerMap = buildHeaderColumnMap(rowXml);

                inputCols = {};
                for (const name of INPUT_FIELD_NAMES) {
                    const col = headerMap.get(name);
                    if (col) inputCols[name] = col;
                }
                if (!inputCols.code) throw new Error('Required column "code" not found in header');
                if (!inputCols.price) throw new Error('Required column "price" not found in header');

                tierCols = {};
                includingVatCols = {};
                for (const [tier, pricelistId] of Object.entries(TIER_TO_PRICELIST_ID)) {
                    const priceCol = headerMap.get(`pricelist:${pricelistId}:price`);
                    const ivCol = headerMap.get(`pricelist:${pricelistId}:includingVat`);
                    if (priceCol) tierCols[tier] = priceCol;
                    if (ivCol) includingVatCols[tier] = ivCol;
                }
                if (Object.keys(tierCols).length === 0) {
                    throw new Error('No pricelist:<id>:price columns found — is this the right export type?');
                }
                log(`Nalezeno ${Object.keys(tierCols).length} ceníkových sloupců.`);

                pushText(rowXml);
                continue;
            }

            if (!tierCols) throw new Error('Data row encountered before header row was parsed');

            rowCount++;
            const row = {};
            for (const [name, col] of Object.entries(inputCols)) row[name] = s(extractCellValue(rowXml, col));

            if (row.code) {
                const tierPrices = calculateAllTierPrices(row, limits);
                const { code, ...syncRow } = row;
                productsForSync.push({ code, row: syncRow });

                for (const [tier, col] of Object.entries(tierCols)) {
                    const current = extractCellValue(rowXml, col);
                    const newPrice = String(tierPrices[tier].price);
                    if (current !== newPrice) {
                        changedCells++;
                        rowXml = replaceNumericCellValue(rowXml, col, newPrice);
                    }
                    const ivCol = includingVatCols[tier];
                    if (ivCol) {
                        const currentIv = extractCellValue(rowXml, ivCol);
                        if (currentIv !== '1') rowXml = setInlineStrValue(rowXml, ivCol, '1');
                    }
                }
            }

            pushText(rowXml);

            if (rowCount % 2000 === 0) log(`...zpracováno ${rowCount} produktů`);
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

    log(`HOTOVO. Produktů: ${rowCount}, přepočtených buněk: ${changedCells}`);
    return { rowCount, changedCells, productsForSync };
}

module.exports = { processProductXlsx };

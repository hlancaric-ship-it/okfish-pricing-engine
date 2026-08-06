import { TIER_NAMES } from './engine/config';
import { calculateAllTierPrices, CsvRow } from './engine/pricing';
import { CsvParserStream } from './csv/csv-parser';
import { buildPricelistXml as buildPricelistXmlShared, PricelistInputs } from '../../shared/pricelist-xml';

export interface Env {
    VIP_KV: KVNamespace;
    FEED_BUCKET: R2Bucket;
    MASTER_FEED_URL: string;
    SHOPTET_WEBHOOK_SIGNING_KEY?: string;
    GITHUB_DISPATCH_TOKEN?: string;
}

// Minimal XML escape — only chars that MUST be escaped (safe for both text content and
// double-quoted attribute values).
function escapeXml(str: string): string {
    if (!/[&<>"']/.test(str)) return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// CSV values use comma decimal separators (e.g. "4,69").
// Returns undefined when the source value is missing/blank.
function parseCommaNumber(val: string | undefined): number | undefined {
    if (!val || val.trim() === '') return undefined;
    const normalized = val.replace(',', '.').replace(/\s/g, '');
    const n = parseFloat(normalized);
    return isNaN(n) ? undefined : n;
}

function toBool(val: string | undefined): boolean {
    return val === '1' || val === 'true';
}

// Emits <TAG>value</TAG>, or a self-closing <TAG/> when value is missing — matches the
// pattern used throughout the real Shoptet reference export for optional fields.
function el(tag: string, value: string | undefined): string {
    return value === undefined ? `<${tag}/>` : `<${tag}>${escapeXml(value)}</${tag}>`;
}

// Per-tier PRICELIST block, built by the single shared generator (shared/pricelist-xml.ts)
// also used by the local CLI (src/cli/generate-xml.ts) — guaranteeing byte-identical
// <PRICELIST> output for equivalent input, rather than two hand-maintained copies that
// can silently drift (that's exactly how the earlier invalid <pricelist:29:price>-style
// passthrough bug happened). No raw CSV column is ever echoed as its own tag — internal
// source columns like variant:, stock:, filteringProperty: and pricelist:<id>:<field> are
// either consumed as calculation input, or simply not part of this feed's output at all.
function buildPricelistXml(row: CsvRow, tier: string, tierResult: { price: number; usedActionPrice: boolean }): string {
    const data: PricelistInputs = {
        price: tierResult.price,
        purchasePrice: parseCommaNumber(row['purchasePrice']),
        standardPrice: parseCommaNumber(row['standardPrice']),
        priceRatio: parseCommaNumber(row['priceRatio']) ?? 1,
        minPriceRatio: 0,
        actionPrice: parseCommaNumber(row['actionPrice']),
        usedActionPrice: tierResult.usedActionPrice,
        // Source feed's price/standardPrice/actionPrice are gross (includingVat=1 for
        // every row) — vatRatePercent lets the shared builder convert to the net value
        // Shoptet's <PRICE> element expects, and also emit <PRICE_VAT>/<VAT> explicitly.
        vatRatePercent: parseCommaNumber(row['percentVat']),
        applyLoyaltyDiscount: toBool(row['applyLoyaltyDiscount']),
        applyVolumeDiscount: toBool(row['applyVolumeDiscount']),
        applyQuantityDiscount: toBool(row['applyQuantityDiscount']),
        applyDiscountCoupon: toBool(row['applyDiscountCoupon']),
        freeShipping: toBool(row['freeShipping']),
        freeBilling: toBool(row['freeBilling']),
        minimalAmount: parseCommaNumber(row['minimumAmount']),
        maximalAmount: parseCommaNumber(row['maximumAmount']),
    };
    return buildPricelistXmlShared(tier, data);
}

// A price-only partial-update SHOPITEM: identified by <CODE>, containing only
// PRICELISTS. Shoptet's update imports apply only the fields present in the feed and
// leave everything else (name, images, description, ...) untouched, so this
// deliberately does not attempt to re-emit product content this worker never had
// reliable, correctly-typed source data for in the first place.
//
// Product matching verified directly against Shoptet's own official sample feed
// (https://www.shoptet.cz/user/documents/VariantItem.xml, linked from
// https://developers.shoptet.com/shoptet-tools/shoptet-xml-specification/), which uses
// a bare <SHOPITEM> with a <CODE> child — no id/import-code attribute. Confirmed by the
// RELAX NG schema (https://www.shoptet.cz/export/schema/products-supplier-v10.rng),
// where id/import-code are both merely *optional* attributes (not the identification
// mechanism), and by Shoptet's own support docs
// (https://podpora.shoptet.cz/automaticke-importy-produktu/): "Kód produktu nebo
// varianty... Párují se podle něj produkty při automatickém importu" — matching for
// automatic import happens via CODE (or EAN), not import-code.
export function buildShopItemXml(row: CsvRow, tierPrices: ReturnType<typeof calculateAllTierPrices>): string {
    const parts: string[] = [`<SHOPITEM>${el('CODE', row['code'])}<PRICELISTS>`];
    for (const tier of TIER_NAMES) {
        const d = tierPrices[tier];
        if (!d) continue;
        parts.push(buildPricelistXml(row, tier, d));
    }
    parts.push('</PRICELISTS></SHOPITEM>\n');
    return parts.join('');
}

// R2's put() needs a known content length up front, which a transformed stream
// doesn't have (output size differs from input CSV size). So the upload must stay
// multipart. But driving it from a manual `while (true) { await reader.read(); await
// uploadPart() }` loop breaks backpressure: reader.read() resolves a chunk as soon as
// it's produced, before we've done anything with it, so the underlying fetch keeps
// buffering further chunks in the background for however long our *separate* uploadPart
// await takes, unbounded — that's what blew past the Worker's memory limit on the real
// feed (see INCIDENTS.md). Driving the same upload from a WritableStream sink via
// pipeTo() instead makes the upload await part of the stream's own backpressure
// mechanism, so upstream fetch is only ever asked for more once we're actually ready.
function createR2MultipartSink(upload: R2MultipartUpload): WritableStream<Uint8Array> {
    // R2/S3 multipart requires every non-final part to be exactly the same size
    // (only the last part may differ), so we carry the exact remainder over
    // between parts. Pending chunks are queued as-is and only copied once, when
    // assembling a complete PART_SIZE part — copying the running "carry" on every
    // single incoming (small, per-row) chunk would be O(rows * partSize) instead
    // of O(total bytes).
    const PART_SIZE = 5 * 1024 * 1024;
    const parts: R2UploadedPart[] = [];
    let partNumber = 1;
    let pendingChunks: Uint8Array<ArrayBufferLike>[] = [];
    let pendingLength = 0;

    async function uploadExact(bytes: Uint8Array<ArrayBufferLike>) {
        const part = await upload.uploadPart(partNumber, bytes);
        parts.push(part);
        partNumber++;
    }

    async function flushExactParts() {
        while (pendingLength >= PART_SIZE) {
            const out = new Uint8Array(PART_SIZE);
            let filled = 0;
            while (filled < PART_SIZE) {
                const head = pendingChunks[0];
                const need = PART_SIZE - filled;
                if (head.length <= need) {
                    out.set(head, filled);
                    filled += head.length;
                    pendingChunks.shift();
                } else {
                    out.set(head.subarray(0, need), filled);
                    filled += need;
                    pendingChunks[0] = head.subarray(need);
                }
            }
            pendingLength -= PART_SIZE;
            await uploadExact(out);
        }
    }

    return new WritableStream<Uint8Array>({
        async write(chunk) {
            pendingChunks.push(chunk);
            pendingLength += chunk.byteLength;
            if (pendingLength >= PART_SIZE) await flushExactParts();
        },
        async close() {
            if (pendingLength > 0) {
                const out = new Uint8Array(pendingLength);
                let offset = 0;
                for (const c of pendingChunks) {
                    out.set(c, offset);
                    offset += c.byteLength;
                }
                await uploadExact(out);
            }
            await upload.complete(parts);
        },
        async abort() {
            await upload.abort().catch(() => {});
        }
    });
}

export function createRowToXmlTransform(onRow: () => void): TransformStream<CsvRow, Uint8Array> {
    const encoder = new TextEncoder();
    return new TransformStream<CsvRow, Uint8Array>({
        start(controller) {
            // Matches exports/products.xml's real Shoptet reference export exactly
            // (encoding names are case-insensitive per the XML spec either way).
            controller.enqueue(encoder.encode('<?xml version="1.0" encoding="UTF-8"?>\n<SHOP>\n'));
        },
        transform(row, controller) {
            if (!row || !row['code']) return;
            controller.enqueue(encoder.encode(buildShopItemXml(row, calculateAllTierPrices(row))));
            onRow();
        },
        flush(controller) {
            controller.enqueue(encoder.encode('</SHOP>\n'));
        }
    });
}

// Real, incremental (streaming) XML well-formedness check, run on the actual encoded
// bytes right before they reach R2 — a genuine tokenizer enforcing XML grammar (tag
// balance/matching, and that '<' / '&' never appear outside of a recognized tag or
// entity), not a guess based on how we think we built the string. Scoped to exactly
// what this generator emits: no DTD, namespaces, comments, or CDATA support, since we
// never produce any of those. Runs as a pass-through stage in the same pipe as
// everything else, so it stays memory-bounded (never buffers the whole document) and a
// violation throws, which propagates through pipeTo() -> aborts the R2 multipart upload
// -> the outer catch marks the run 'failed' without ever switching the active feed.
// Cross-checked independently against a real published parser (fast-xml-parser) in
// tests/xml-validation.test.ts.
export function createXmlWellFormednessValidator(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    let buffer = '';
    const stack: string[] = [];
    let sawRoot = false;

    const NAME_START = /[A-Za-z_]/;
    const VALID_ENTITY = /^(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/;

    function processBuffer(final: boolean) {
        let i = 0;
        while (i < buffer.length) {
            const ch = buffer[i];

            if (ch === '<') {
                if (buffer.startsWith('<?', i)) {
                    const end = buffer.indexOf('?>', i);
                    if (end === -1) { if (!final) break; throw new Error('Unterminated processing instruction'); }
                    i = end + 2;
                    continue;
                }
                if (buffer.startsWith('</', i)) {
                    const end = buffer.indexOf('>', i);
                    if (end === -1) { if (!final) break; throw new Error('Unterminated closing tag'); }
                    const name = buffer.slice(i + 2, end).trim();
                    const expected = stack.pop();
                    if (expected !== name) {
                        throw new Error(`Mismatched closing tag: expected </${expected}>, got </${name}>`);
                    }
                    i = end + 1;
                    continue;
                }
                // Opening (or self-closing) tag — need the full "<...>" before we can safely
                // parse it (attribute values may contain '>' between quotes).
                const tagEnd = findTagEnd(buffer, i);
                if (tagEnd === -1) { if (!final) break; throw new Error('Unterminated tag'); }
                const raw = buffer.slice(i + 1, tagEnd);
                const selfClosing = raw.endsWith('/');
                const body = selfClosing ? raw.slice(0, -1) : raw;
                const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(body);
                if (!nameMatch || !NAME_START.test(body[0] ?? '')) {
                    throw new Error(`Invalid element name at "<${body}>"`);
                }
                const name = nameMatch[0];
                if (!selfClosing) {
                    stack.push(name);
                    sawRoot = true;
                }
                i = tagEnd + 1;
                continue;
            }

            if (ch === '&') {
                const rest = buffer.slice(i + 1);
                if (!VALID_ENTITY.test(rest)) {
                    if (!final && rest.length < 12) break; // might just need more data
                    throw new Error(`Unescaped "&" (invalid entity) at position ${i}`);
                }
                i += 1 + rest.match(VALID_ENTITY)![0].length;
                continue;
            }

            if (ch === '>') {
                throw new Error(`Unescaped ">" outside of a tag at position ${i}`);
            }

            i++;
        }
        buffer = buffer.slice(i);
    }

    function findTagEnd(s: string, start: number): number {
        let inQuote: string | null = null;
        for (let j = start + 1; j < s.length; j++) {
            const c = s[j];
            if (inQuote) {
                if (c === inQuote) inQuote = null;
            } else if (c === '"' || c === "'") {
                inQuote = c;
            } else if (c === '>' && !inQuote) {
                return j;
            }
        }
        return -1;
    }

    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            processBuffer(false);
            controller.enqueue(chunk);
        },
        flush() {
            buffer += decoder.decode();
            processBuffer(true);
            if (!sawRoot || stack.length > 0) {
                throw new Error(`XML not well-formed: ${stack.length} unclosed element(s) at end of document`);
            }
        }
    });
}

export async function runFeedGeneration(env: Env, filename: string, version: string): Promise<void> {
    const startTime = Date.now();

    await env.VIP_KV.put('feed_generation_status', JSON.stringify({
        status: 'running',
        startedAt: new Date(startTime).toISOString(),
        processedProducts: 0,
        totalProducts: null,
    }));

    let processed = 0;
    let lastKvUpdate = Date.now();

    // Periodic status ping while the stream is uploading — the pipeline below
    // runs to completion inside the single `pipeTo()` await, so there's no per-row
    // loop to hook a status update into; poll the shared counter on a timer instead.
    const statusTimer = setInterval(() => {
        const now = Date.now();
        if (now - lastKvUpdate < 3000) return;
        lastKvUpdate = now;
        env.VIP_KV.put('feed_generation_status', JSON.stringify({
            status: 'running',
            startedAt: new Date(startTime).toISOString(),
            processedProducts: processed,
            totalProducts: null,
        })).catch(() => {});
    }, 3000);

    try {
        console.log('Feed gen: fetch CSV');
        const res = await fetch(env.MASTER_FEED_URL);
        if (!res.ok || !res.body) throw new Error(`Fetch failed: HTTP ${res.status}`);

        const upload = await env.FEED_BUCKET.createMultipartUpload(filename, {
            httpMetadata: { contentType: 'application/xml; charset=utf-8' }
        });

        const xmlStream = res.body
            .pipeThrough(new CsvParserStream())
            .pipeThrough(createRowToXmlTransform(() => { processed++; }))
            .pipeThrough(createXmlWellFormednessValidator());

        // If the validator (or anything upstream) throws, this pipeTo() rejects,
        // which invokes the sink's abort() -> upload.abort() -> we land in the
        // catch below with status 'failed' and 'active_feed' never touched.
        await xmlStream.pipeTo(createR2MultipartSink(upload));
        console.log(`Feed gen: R2 multipart upload complete, total products=${processed}`);

        clearInterval(statusTimer);

        // Switch active feed
        await env.VIP_KV.put('active_feed', JSON.stringify({
            filename, version, generatedAt: new Date().toISOString()
        }));

        const durationSeconds = Math.round((Date.now() - startTime) / 1000);
        await env.VIP_KV.put('feed_generation_status', JSON.stringify({
            status: 'success',
            startedAt: new Date(startTime).toISOString(),
            processedProducts: processed,
            totalProducts: processed,
            progress: 100,
            durationSeconds,
            feedVersion: version
        }));
        console.log(`Feed gen: SUCCESS products=${processed} duration=${durationSeconds}s`);

    } catch (e: any) {
        clearInterval(statusTimer);
        console.error('Feed gen: FAILED:', e?.message ?? e);
        await env.VIP_KV.put('feed_generation_status', JSON.stringify({
            status: 'failed',
            startedAt: new Date(startTime).toISOString(),
            error: e?.message ?? String(e)
        }));
        throw e;
    }
}
